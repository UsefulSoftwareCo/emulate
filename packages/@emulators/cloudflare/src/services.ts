import type {
  AppEnv,
  AppKeyResolver,
  CredentialRequest,
  Hono,
  IssuedCredential,
  ServiceManifest,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import {
  getGitHubStore,
  githubPlugin,
  manifest as githubManifest,
  seedFromConfig as githubSeed,
} from "@emulators/github";
import {
  getVercelStore,
  manifest as vercelManifest,
  seedFromConfig as vercelSeed,
  vercelPlugin,
} from "@emulators/vercel";
import { googlePlugin, manifest as googleManifest, seedFromConfig as googleSeed } from "@emulators/google";
import { manifest as oktaManifest, oktaPlugin, seedFromConfig as oktaSeed } from "@emulators/okta";
import { manifest as microsoftManifest, microsoftPlugin, seedFromConfig as microsoftSeed } from "@emulators/microsoft";
import { mcpPlugin, setMcpAuthConfig } from "@emulators/mcp";
import { manifest as spotifyManifest, seedFromConfig as spotifySeed, spotifyPlugin } from "@emulators/spotify";
import { manifest as slackManifest, seedFromConfig as slackSeed, slackPlugin } from "@emulators/slack";
import { applePlugin, manifest as appleManifest, seedFromConfig as appleSeed } from "@emulators/apple";
import { awsPlugin, getAwsStore, manifest as awsManifest, seedFromConfig as awsSeed } from "@emulators/aws";
import { manifest as resendManifest, resendPlugin, seedFromConfig as resendSeed } from "@emulators/resend";
import { manifest as stripeManifest, seedFromConfig as stripeSeed, stripePlugin } from "@emulators/stripe";
import {
  manifest as mongoatlasManifest,
  mongoatlasPlugin,
  seedFromConfig as mongoatlasSeed,
} from "@emulators/mongoatlas";
import { clerkPlugin, manifest as clerkManifest, seedFromConfig as clerkSeed } from "@emulators/clerk";
import { getXStore, manifest as xManifest, seedFromConfig as xSeed, xPlugin } from "@emulators/x";
import {
  getWorkosStore,
  manifest as workosManifest,
  seedFromConfig as workosSeed,
  workosPlugin,
} from "@emulators/workos";
import { autumnPlugin, manifest as autumnManifest, seedFromConfig as autumnSeed } from "@emulators/autumn";

// GitHub exposes three surfaces over ONE store: REST + GraphQL (githubPlugin) and
// an MCP server (mcpPlugin's transport + OAuth/DCR routes). They compose cleanly —
// no path overlap (github uses /login/oauth/*, mcp uses /authorize·/token·/register·
// /mcp·/.well-known/oauth-*). So MCP lives at `/github/<inst>/mcp`, alongside
// `/github/<inst>/repos/...` and `/github/<inst>/graphql`.
const githubWithMcpPlugin: ServicePlugin = {
  name: "github",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    githubPlugin.register(app, store, webhooks, baseUrl, tokenMap);
    mcpPlugin.register(app, store, webhooks, baseUrl, tokenMap);
  },
  seed(store: Store, baseUrl: string): void {
    githubPlugin.seed?.(store, baseUrl);
  },
};

// The CF build statically bundles the service plugins it supports (vs the CLI's
// fs/dynamic-import registry, which Workers can't do). Each entry mirrors the
// upstream SERVICE_REGISTRY wiring (fallback identity + per-service seeding +
// the GitHub App key resolver). The manifest comes from the plugin package — the
// single source of truth shared with the CLI and the console. Add a service =
// import its plugin + manifest + register it.
export interface ServiceEntry {
  plugin: ServicePlugin;
  manifest: ServiceManifest;
  seedFromConfig?: (store: Store, baseUrl: string, config: Record<string, unknown>) => void;
  defaultFallback: (cfg?: Record<string, unknown>) => { login: string; id: number; scopes: string[] };
  createAppKeyResolver?: (store: Store) => AppKeyResolver;
  // Idempotently find-or-create the identity behind a minted token; returns its
  // numeric store id (for the token→user mapping). Used by the /__token endpoint.
  ensureUser?: (store: Store, baseUrl: string, login: string) => number;
  // Configure an instance for a URL-selected preset (e.g. the MCP connection-type
  // routes `/oauth/mcp` · `/bearer/mcp` · `/query/mcp`), instead of a seed call.
  applyPreset?: (store: Store, baseUrl: string, preset: string) => void;
  // Provider-specific credential issuance (e.g. AWS access keys) that doesn't fit
  // the bearer / api-key / oauth-client paths below.
  issueCredential?: (store: Store, baseUrl: string, request: CredentialRequest) => IssuedCredential;
}

export const SERVICES: Record<string, ServiceEntry> = {
  github: {
    plugin: githubWithMcpPlugin,
    manifest: githubManifest,
    seedFromConfig: githubSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin",
      id: 1,
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    }),
    createAppKeyResolver: (store) => (appId: number) => {
      try {
        const gh = getGitHubStore(store);
        const app = gh.apps.all().find((a) => a.app_id === appId);
        return app ? { privateKey: app.private_key, slug: app.slug, name: app.name } : null;
      } catch {
        return null;
      }
    },
    ensureUser: (store, baseUrl, login) => {
      githubSeed(store, baseUrl, { users: [{ login }] });
      return getGitHubStore(store).users.findOneBy("login", login)?.id ?? 1;
    },
    // `/github/oauth/mcp` · `/github/bearer/mcp` · `/github/query/mcp` pin the MCP
    // surface's auth mode by URL (the instance segment IS the connection type).
    applyPreset: (store, _baseUrl, preset) => setMcpAuthConfig(store, { auth: preset }),
  },
  vercel: {
    plugin: vercelPlugin,
    manifest: vercelManifest,
    seedFromConfig: vercelSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ username?: string }> | undefined)?.[0]?.username ?? "admin",
      id: 1,
      scopes: [],
    }),
    ensureUser: (store, baseUrl, login) => {
      vercelSeed(store, baseUrl, { users: [{ username: login }] });
      return getVercelStore(store).users.findOneBy("username", login)?.id ?? 1;
    },
  },
  // OIDC / OAuth 2.0 providers — the connect-flow side. Auth comes from the real
  // authorize→token dance (client_secret + PKCE + code validated faithfully), not
  // bearer minting, so no ensureUser. defaultFallback only applies in permissive
  // mode (strict drops it).
  google: {
    plugin: googlePlugin,
    manifest: googleManifest,
    seedFromConfig: googleSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  okta: {
    plugin: oktaPlugin,
    manifest: oktaManifest,
    seedFromConfig: oktaSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  microsoft: {
    plugin: microsoftPlugin,
    manifest: microsoftManifest,
    seedFromConfig: microsoftSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  // Spotify Web API — the canonical OAuth 2.0 Client Credentials provider. The
  // token endpoint (/api/token) mints an app token from client_id/secret (Basic
  // header or body); the catalog (search/artists/albums/tracks) requires that
  // bearer. No users — /v1/me is rejected, like real Spotify with an app token.
  spotify: {
    plugin: spotifyPlugin,
    manifest: spotifyManifest,
    seedFromConfig: spotifySeed,
    defaultFallback: () => ({ login: "spotify-app", id: 1, scopes: [] }),
  },
  slack: {
    plugin: slackPlugin,
    manifest: slackManifest,
    seedFromConfig: slackSeed,
    defaultFallback: () => ({ login: "U000000001", id: 1, scopes: [] }),
  },
  apple: {
    plugin: applePlugin,
    manifest: appleManifest,
    seedFromConfig: appleSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@icloud.com",
      id: 1,
      scopes: ["openid", "email", "name"],
    }),
  },
  aws: {
    plugin: awsPlugin,
    manifest: awsManifest,
    seedFromConfig: awsSeed,
    defaultFallback: () => ({ login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] }),
    issueCredential: (store, baseUrl, request) => {
      const userName = request.login ?? "developer";
      awsSeed(store, baseUrl, { iam: { users: [{ user_name: userName, create_access_key: true }] } });
      const user = getAwsStore(store).iamUsers.findOneBy("user_name", userName);
      const key = user?.access_keys.find((candidate) => candidate.status === "Active");
      if (!user || !key) throw new Error("Failed to create AWS access key");
      return {
        type: "provider-specific",
        provider: "aws",
        user_name: user.user_name,
        access_key_id: key.access_key_id,
        secret_access_key: key.secret_access_key,
        region: "us-east-1",
      };
    },
  },
  resend: {
    plugin: resendPlugin,
    manifest: resendManifest,
    seedFromConfig: resendSeed,
    defaultFallback: () => ({ login: "re_test_admin", id: 1, scopes: [] }),
  },
  stripe: {
    plugin: stripePlugin,
    manifest: stripeManifest,
    seedFromConfig: stripeSeed,
    defaultFallback: () => ({ login: "sk_test_admin", id: 1, scopes: [] }),
  },
  mongoatlas: {
    plugin: mongoatlasPlugin,
    manifest: mongoatlasManifest,
    seedFromConfig: mongoatlasSeed,
    defaultFallback: () => ({ login: "admin", id: 1, scopes: [] }),
  },
  clerk: {
    plugin: clerkPlugin,
    manifest: clerkManifest,
    seedFromConfig: clerkSeed,
    defaultFallback: (cfg) => ({
      login:
        (cfg?.users as Array<{ email_addresses?: string[] }> | undefined)?.[0]?.email_addresses?.[0] ??
        "test@example.com",
      id: 1,
      scopes: [],
    }),
  },
  // X (Twitter) API v2 — its real auth strategies: app-only Bearer (client
  // credentials) and OAuth 2.0 Authorization Code with PKCE (confidential clients
  // use HTTP Basic, public clients send client_id + PKCE only). Tokens are
  // validated from the store, so no bearer minting here; defaultFallback only
  // applies in permissive mode.
  x: {
    plugin: xPlugin,
    manifest: xManifest,
    seedFromConfig: xSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ username?: string }> | undefined)?.[0]?.username ?? "developer",
      id: 1,
      scopes: ["tweet.read", "users.read"],
    }),
    ensureUser: (store, baseUrl, login) => {
      xSeed(store, baseUrl, { users: [{ username: login }] });
      return getXStore(store).users.findOneBy("username", login.toLowerCase().replace(/^@/, ""))?.id ?? 1;
    },
  },
  workos: {
    plugin: workosPlugin,
    manifest: workosManifest,
    seedFromConfig: workosSeed,
    defaultFallback: () => ({ login: "sk_emulate_admin", id: 1, scopes: [] }),
    ensureUser: (store, baseUrl, login) => {
      workosSeed(store, baseUrl, { users: [{ email: login }] });
      return getWorkosStore(store).users.findOneBy("email", login)?.id ?? 1;
    },
  },
  autumn: {
    plugin: autumnPlugin,
    manifest: autumnManifest,
    seedFromConfig: autumnSeed,
    defaultFallback: () => ({ login: "am_emulate_admin", id: 1, scopes: [] }),
  },
};

export type ServiceName = keyof typeof SERVICES;

export function issueCloudflareCredential(
  service: string,
  entry: ServiceEntry,
  store: Store,
  baseUrl: string,
  tokenMap: TokenMap | undefined,
  request: CredentialRequest,
): IssuedCredential {
  if (entry.issueCredential) {
    return entry.issueCredential(store, baseUrl, request);
  }
  const type = request.type ?? entry.manifest.auth[0]?.type ?? "bearer-token";
  if (type === "bearer-token" || type === "api-key") {
    if (!tokenMap) throw new Error(`Credential type ${type} is not supported by ${service}`);
    const login = request.login ?? "admin";
    const scopes = Array.isArray(request.scopes)
      ? request.scopes.filter((s): s is string => typeof s === "string")
      : [];
    const id = entry.ensureUser?.(store, baseUrl, login) ?? Date.now();
    const token =
      typeof request.token === "string" && request.token.length > 0
        ? request.token
        : `${tokenPrefix(service, type)}_${idPart()}`;
    tokenMap.set(token, { login, id, scopes });
    return { type, token, login, scopes };
  }

  if (
    type === "oauth-authorization-code" ||
    type === "oauth-client-credentials" ||
    type === "dynamic-client-registration"
  ) {
    if (!entry.seedFromConfig) throw new Error(`Credential type ${type} is not supported by ${service}`);
    const clientId = request.client_id ?? defaultClientId(service);
    const clientSecret = request.client_secret ?? defaultClientSecret(service);
    const redirectUris = normalizeRedirectUris(request.redirect_uris);
    const name = request.name ?? `${entry.manifest.name} Client`;
    const seed = credentialSeed(service, { clientId, clientSecret, redirectUris, name, request });
    if (!seed) throw new Error(`Credential type ${type} is not supported by ${service}`);
    entry.seedFromConfig(store, baseUrl, seed);
    return {
      type,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      authorization_url: authorizationUrlFor(service, baseUrl),
      token_url: tokenUrlFor(service, baseUrl),
    };
  }

  throw new Error(`Credential type ${type} is not supported by ${service}`);
}

function tokenPrefix(service: string, type: string): string {
  if (type === "api-key" && service === "stripe") return "sk_test";
  if (type === "api-key" && service === "clerk") return "sk_test";
  if (type === "api-key" && service === "resend") return "re";
  return `emu_${service}`;
}

function defaultClientId(service: string): string {
  if (service === "spotify") return `app_${idPart().slice(0, 18)}`;
  if (service === "github") return `Iv1.${idPart().slice(0, 16)}`;
  if (service === "google") return `${idPart().slice(0, 24)}.apps.googleusercontent.com`;
  return `${service}_${idPart().slice(0, 18)}`;
}

function defaultClientSecret(service: string): string {
  if (service === "google") return `GOCSPX-${idPart().slice(0, 24)}`;
  return `secret_${idPart()}`;
}

function normalizeRedirectUris(value: unknown): string[] {
  if (Array.isArray(value)) {
    const uris = value.filter((uri): uri is string => typeof uri === "string" && uri.length > 0);
    if (uris.length > 0) return uris;
  }
  return ["http://localhost:3000/callback"];
}

function credentialSeed(
  service: string,
  args: {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    name: string;
    request: CredentialRequest;
  },
): Record<string, unknown> | null {
  const { clientId, clientSecret, redirectUris, name, request } = args;
  if (service === "github") {
    return { oauth_apps: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
  }
  if (service === "google" || service === "microsoft" || service === "apple") {
    return { oauth_clients: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
  }
  if (service === "vercel") {
    return { integrations: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
  }
  if (service === "spotify") {
    return { clients: [{ client_id: clientId, client_secret: clientSecret, name }] };
  }
  if (service === "okta") {
    return {
      oauth_clients: [
        {
          client_id: clientId,
          client_secret: clientSecret,
          name,
          redirect_uris: redirectUris,
          auth_server_id: typeof request.auth_server_id === "string" ? request.auth_server_id : "default",
        },
      ],
    };
  }
  if (service === "slack") {
    return {
      oauth_apps: [
        {
          client_id: clientId,
          client_secret: clientSecret,
          name,
          redirect_uris: redirectUris,
          scopes: Array.isArray(request.scopes) ? request.scopes : ["chat:write", "channels:read", "users:read"],
          user_scopes: Array.isArray(request.user_scopes) ? request.user_scopes : [],
        },
      ],
    };
  }
  if (service === "clerk") {
    return {
      oauth_applications: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }],
    };
  }
  if (service === "x") {
    return {
      oauth_clients: [
        {
          client_id: clientId,
          client_secret: clientSecret,
          client_type: "confidential",
          name,
          redirect_uris: redirectUris,
        },
      ],
    };
  }
  return null;
}

function tokenUrlFor(service: string, baseUrl: string): string | undefined {
  const paths: Record<string, string> = {
    github: "/login/oauth/access_token",
    google: "/token",
    apple: "/auth/token",
    microsoft: "/oauth2/v2.0/token",
    okta: "/oauth2/default/v1/token",
    slack: "/api/oauth.v2.access",
    vercel: "/v2/oauth/access_token",
    spotify: "/api/token",
    clerk: "/oauth/token",
    x: "/2/oauth2/token",
  };
  return paths[service] ? `${baseUrl}${paths[service]}` : undefined;
}

function authorizationUrlFor(service: string, baseUrl: string): string | undefined {
  const paths: Record<string, string> = {
    github: "/login/oauth/authorize",
    google: "/o/oauth2/v2/auth",
    apple: "/auth/authorize",
    microsoft: "/oauth2/v2.0/authorize",
    okta: "/oauth2/default/v1/authorize",
    slack: "/oauth/v2/authorize",
    vercel: "/integrations/oauth/authorize",
    clerk: "/oauth/authorize",
    x: "/2/oauth2/authorize",
  };
  return paths[service] ? `${baseUrl}${paths[service]}` : undefined;
}

function idPart(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
