import type { AppEnv, AppKeyResolver, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig as githubSeed } from "@emulators/github";
import { getVercelStore, seedFromConfig as vercelSeed, vercelPlugin } from "@emulators/vercel";
import { googlePlugin, seedFromConfig as googleSeed } from "@emulators/google";
import { oktaPlugin, seedFromConfig as oktaSeed } from "@emulators/okta";
import { microsoftPlugin, seedFromConfig as microsoftSeed } from "@emulators/microsoft";
import { mcpPlugin, setMcpAuthConfig } from "@emulators/mcp";
import { spotifyPlugin, seedFromConfig as spotifySeed } from "@emulators/spotify";

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
// the GitHub App key resolver). Add a service = import its plugin + register it.
export interface ServiceEntry {
  plugin: typeof githubPlugin;
  seedFromConfig?: (store: Store, baseUrl: string, config: Record<string, unknown>) => void;
  defaultFallback: (cfg?: Record<string, unknown>) => { login: string; id: number; scopes: string[] };
  createAppKeyResolver?: (store: Store) => AppKeyResolver;
  // Idempotently find-or-create the identity behind a minted token; returns its
  // numeric store id (for the token→user mapping). Used by the /__token endpoint.
  ensureUser?: (store: Store, baseUrl: string, login: string) => number;
  // Configure an instance for a URL-selected preset (e.g. the MCP connection-type
  // routes `/oauth/mcp` · `/bearer/mcp` · `/query/mcp`), instead of a seed call.
  applyPreset?: (store: Store, baseUrl: string, preset: string) => void;
}

export const SERVICES: Record<string, ServiceEntry> = {
  github: {
    plugin: githubWithMcpPlugin,
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
    seedFromConfig: googleSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  okta: {
    plugin: oktaPlugin,
    seedFromConfig: oktaSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  microsoft: {
    plugin: microsoftPlugin,
    seedFromConfig: microsoftSeed,
    defaultFallback: (cfg) => ({
      login: (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "admin",
      id: 1,
      scopes: ["openid", "email", "profile"],
    }),
  },
  // (GitHub MCP is no longer a top-level service — it's a surface of `github`,
  // at /github/<inst>/mcp. See githubWithMcpPlugin above.)
  // Spotify Web API — the canonical OAuth 2.0 Client Credentials provider. The
  // token endpoint (/api/token) mints an app token from client_id/secret (Basic
  // header or body); the catalog (search/artists/albums/tracks) requires that
  // bearer. No users — /v1/me is rejected, like real Spotify with an app token.
  spotify: {
    plugin: spotifyPlugin,
    seedFromConfig: spotifySeed,
    defaultFallback: () => ({ login: "spotify-app", id: 1, scopes: [] }),
  },
};

export type ServiceName = keyof typeof SERVICES;
