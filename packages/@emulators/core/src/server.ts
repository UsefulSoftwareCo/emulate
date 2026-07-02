import { Hono, cors } from "./http.js";
import { Store } from "./store.js";
import { WebhookDispatcher } from "./webhooks.js";
import { createApiErrorHandler, createErrorHandler } from "./middleware/error-handler.js";
import {
  authMiddleware,
  type AuthFallback,
  type TokenMap,
  type AppKeyResolver,
  type AppEnv,
} from "./middleware/auth.js";
import type { ServicePlugin } from "./plugin.js";
import { registerFontRoutes } from "./fonts.js";
import { RequestLedger, createLedgerMiddleware } from "./ledger.js";
import { registerControlPlane, type CredentialRequest, type IssuedCredential } from "./control-plane.js";
import { createDefaultManifest, type ServiceManifest } from "./manifest.js";
import { FaultRegistry, createFaultMiddleware } from "./faults.js";

export interface ServerOptions {
  port?: number;
  baseUrl?: string;
  docsUrl?: string;
  tokens?: Record<string, { login: string; id: number; scopes?: string[] }>;
  appKeyResolver?: AppKeyResolver;
  fallbackUser?: AuthFallback;
  manifest?: ServiceManifest;
  instance?: string;
  enableControlPlane?: boolean;
  /** True when the host persists the ledger across eviction (e.g. a Durable Object). */
  ledgerPersistent?: boolean;
  /** Host suffix for the deployed form surfaced in control-plane responses. */
  hostSuffix?: string;
  reset?: () => void | Promise<void>;
  seed?: (seed: unknown) => void | Promise<void>;
  issueCredential?: (request: CredentialRequest) => IssuedCredential | Promise<IssuedCredential>;
}

export function createServer(plugin: ServicePlugin, options: ServerOptions = {}) {
  const port = options.port ?? 4000;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;

  const app = new Hono<AppEnv>();
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const ledger = new RequestLedger();
  const faults = new FaultRegistry();

  const tokenMap: TokenMap = new Map();
  if (options.tokens) {
    for (const [token, user] of Object.entries(options.tokens)) {
      tokenMap.set(token, {
        login: user.login,
        id: user.id,
        scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
      });
    }
  }

  const docsUrl = options.docsUrl ?? `https://docs.emulators.dev/${plugin.name}`;

  registerFontRoutes(app);

  app.onError(createApiErrorHandler(docsUrl));
  app.use("*", cors());
  app.use("*", createErrorHandler(docsUrl));
  app.use("*", authMiddleware(tokenMap, options.appKeyResolver, options.fallbackUser));

  if (options.enableControlPlane !== false) {
    const manifest = options.manifest ?? createDefaultManifest(plugin.name);
    registerControlPlane(app, {
      manifest,
      instance: {
        service: manifest.id,
        instance: options.instance,
        baseUrl,
        providerBaseUrl: baseUrl,
        controlBaseUrl: `${baseUrl}/_emulate`,
      },
      store,
      webhooks,
      ledger,
      faults,
      tokenMap,
      ledgerPersistent: options.ledgerPersistent,
      hostSuffix: options.hostSuffix,
      reset: options.reset,
      seed: options.seed,
      issueCredential: options.issueCredential,
    });
  }

  app.use("*", createLedgerMiddleware(ledger, { webhooks }));
  app.use("*", createFaultMiddleware(faults, options.manifest ?? createDefaultManifest(plugin.name)));

  const rateLimitCounters = new Map<string, { remaining: number; resetAt: number }>();
  let lastPruneAt = Math.floor(Date.now() / 1000);

  app.use("*", async (c, next) => {
    const token = c.get("authToken") ?? "__anonymous__";
    const now = Math.floor(Date.now() / 1000);

    if (now - lastPruneAt > 3600) {
      for (const [key, val] of rateLimitCounters) {
        if (val.resetAt <= now) rateLimitCounters.delete(key);
      }
      lastPruneAt = now;
    }

    let counter = rateLimitCounters.get(token);
    if (!counter || counter.resetAt <= now) {
      counter = { remaining: 5000, resetAt: now + 3600 };
      rateLimitCounters.set(token, counter);
    }

    counter.remaining = Math.max(0, counter.remaining - 1);

    c.header("X-RateLimit-Limit", "5000");
    c.header("X-RateLimit-Remaining", String(counter.remaining));
    c.header("X-RateLimit-Reset", String(counter.resetAt));
    c.header("X-RateLimit-Resource", "core");

    if (counter.remaining === 0) {
      return c.json(
        {
          message: "API rate limit exceeded",
          documentation_url: docsUrl,
        },
        403,
      );
    }

    await next();
  });

  plugin.register(app, store, webhooks, baseUrl, tokenMap);

  app.notFound((c) =>
    c.json(
      {
        message: "Not Found",
        documentation_url: docsUrl,
      },
      404,
    ),
  );

  return { app, store, webhooks, ledger, faults, port, baseUrl, tokenMap };
}
