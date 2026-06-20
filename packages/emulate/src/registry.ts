import type {
  ServicePlugin,
  Store,
  AppKeyResolver,
  AuthFallback,
  WebhookDispatcher,
  ServiceManifest,
  CredentialRequest,
  IssuedCredential,
  TokenMap,
  Hono,
  AppEnv,
} from "@emulators/core";

export interface LoadedService {
  plugin: ServicePlugin;
  // Each plugin owns its manifest (the single source of truth). load() resolves
  // it lazily alongside the plugin so the CLI never eager-loads every service.
  manifest: ServiceManifest;
  seedFromConfig?(store: Store, baseUrl: string, config: unknown, webhooks?: WebhookDispatcher): void;
  createAppKeyResolver?(store: Store): AppKeyResolver;
  ensureUser?(store: Store, baseUrl: string, login: string): number;
  issueCredential?(
    store: Store,
    baseUrl: string,
    tokenMap: TokenMap,
    request: CredentialRequest,
    webhooks?: WebhookDispatcher,
  ): IssuedCredential;
}

export interface ServiceEntry {
  label: string;
  endpoints: string;
  load(): Promise<LoadedService>;
  defaultFallback(svcSeedConfig?: Record<string, unknown>): AuthFallback;
  initConfig: Record<string, unknown>;
}

const SERVICE_NAME_LIST = [
  "vercel",
  "github",
  "google",
  "slack",
  "apple",
  "microsoft",
  "okta",
  "aws",
  "resend",
  "stripe",
  "mongoatlas",
  "clerk",
  "spotify",
  "x",
  "workos",
  "autumn",
  "mcp",
] as const;
export type ServiceName = (typeof SERVICE_NAME_LIST)[number];
export const SERVICE_NAMES: readonly ServiceName[] = SERVICE_NAME_LIST;

export function issueServiceCredential(
  service: ServiceName,
  loaded: LoadedService,
  store: Store,
  baseUrl: string,
  tokenMap: TokenMap,
  request: CredentialRequest,
  webhooks?: WebhookDispatcher,
): IssuedCredential {
  if (loaded.issueCredential) {
    return loaded.issueCredential(store, baseUrl, tokenMap, request, webhooks);
  }
  const type = request.type ?? loaded.manifest.auth[0]?.type ?? "bearer-token";
  if (type === "bearer-token" || type === "api-key") {
    const login = request.login ?? "admin";
    const scopes = Array.isArray(request.scopes)
      ? request.scopes.filter((s): s is string => typeof s === "string")
      : [];
    const id = loaded.ensureUser?.(store, baseUrl, login) ?? Date.now();
    const token =
      typeof request.token === "string" && request.token.length > 0 ? request.token : defaultToken(service, type);
    tokenMap.set(token, { login, id, scopes });
    return { type, token, login, scopes };
  }

  if (
    type === "oauth-authorization-code" ||
    type === "oauth-client-credentials" ||
    type === "dynamic-client-registration"
  ) {
    if (!loaded.seedFromConfig) throw new Error(`Credential type ${type} is not supported by ${service}`);
    const clientId = request.client_id ?? defaultClientId(service);
    const clientSecret = request.client_secret ?? defaultClientSecret(service);
    const redirectUris = normalizeRedirectUris(request.redirect_uris);
    const name = request.name ?? `${SERVICE_REGISTRY[service].label.replace(/ emulator$/i, "")} Client`;
    const seed = credentialSeed(service, { clientId, clientSecret, redirectUris, name, request });
    if (!seed) throw new Error(`Credential type ${type} is not supported by ${service}`);
    loaded.seedFromConfig(store, baseUrl, seed, webhooks);
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

function defaultToken(service: ServiceName, type: string): string {
  const prefix = type === "api-key" ? apiKeyPrefix(service) : `emu_${service}`;
  return `${prefix}_${randomId()}`;
}

function apiKeyPrefix(service: ServiceName): string {
  if (service === "stripe") return "sk_test";
  if (service === "resend") return "re";
  if (service === "clerk") return "sk_test";
  return `emu_${service}`;
}

function defaultClientId(service: ServiceName): string {
  if (service === "spotify") return `app_${randomId().slice(0, 18)}`;
  if (service === "github") return `Iv1.${randomId().slice(0, 16)}`;
  if (service === "google") return `${randomId().slice(0, 24)}.apps.googleusercontent.com`;
  return `${service}_${randomId().slice(0, 18)}`;
}

function defaultClientSecret(service: ServiceName): string {
  if (service === "google") return `GOCSPX-${randomId().slice(0, 24)}`;
  return `secret_${randomId()}`;
}

function normalizeRedirectUris(value: unknown): string[] {
  if (Array.isArray(value)) {
    const uris = value.filter((uri): uri is string => typeof uri === "string" && uri.length > 0);
    if (uris.length > 0) return uris;
  }
  return ["http://localhost:3000/callback"];
}

function credentialSeed(
  service: ServiceName,
  args: {
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    name: string;
    request: CredentialRequest;
  },
): unknown | null {
  const { clientId, clientSecret, redirectUris, name, request } = args;
  if (service === "github") {
    return { oauth_apps: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
  }
  if (service === "google" || service === "apple" || service === "microsoft") {
    return { oauth_clients: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
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
  if (service === "vercel") {
    return { integrations: [{ client_id: clientId, client_secret: clientSecret, name, redirect_uris: redirectUris }] };
  }
  if (service === "spotify") {
    return { clients: [{ client_id: clientId, client_secret: clientSecret, name }] };
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

function tokenUrlFor(service: ServiceName, baseUrl: string): string | undefined {
  const paths: Partial<Record<ServiceName, string>> = {
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
  const path = paths[service];
  return path ? `${baseUrl}${path}` : undefined;
}

function authorizationUrlFor(service: ServiceName, baseUrl: string): string | undefined {
  const paths: Partial<Record<ServiceName, string>> = {
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
  const path = paths[service];
  return path ? `${baseUrl}${path}` : undefined;
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export const SERVICE_REGISTRY: Record<ServiceName, ServiceEntry> = {
  vercel: {
    label: "Vercel REST API emulator",
    endpoints: "projects, deployments, domains, env vars, users, teams, file uploads, protection bypass",
    async load() {
      const mod = await import("@emulators/vercel");
      return {
        plugin: mod.vercelPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        ensureUser(store: Store, baseUrl: string, login: string): number {
          mod.seedFromConfig(store, baseUrl, { users: [{ username: login }] });
          return mod.getVercelStore(store).users.findOneBy("username", login)?.id ?? 1;
        },
      };
    },
    defaultFallback(cfg) {
      const firstLogin = (cfg?.users as Array<{ username?: string }> | undefined)?.[0]?.username ?? "admin";
      return { login: firstLogin, id: 1, scopes: [] };
    },
    initConfig: {
      vercel: {
        users: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
        teams: [{ slug: "my-team", name: "My Team" }],
        projects: [{ name: "my-app", team: "my-team", framework: "nextjs" }],
        integrations: [
          {
            client_id: "oac_example_client_id",
            client_secret: "example_client_secret",
            name: "My Vercel App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/vercel"],
          },
        ],
      },
    },
  },

  github: {
    label: "GitHub REST API emulator",
    endpoints:
      "users, repos, issues, PRs, comments, reviews, labels, milestones, branches, git data, orgs, teams, releases, webhooks, search, actions, checks, rate limit",
    async load() {
      const mod = await import("@emulators/github");
      const mcp = await import("@emulators/mcp");
      const githubWithMcpPlugin: ServicePlugin = {
        name: "github",
        register(
          app: Hono<AppEnv>,
          store: Store,
          webhooks: WebhookDispatcher,
          baseUrl: string,
          tokenMap?: TokenMap,
        ): void {
          mod.githubPlugin.register(app, store, webhooks, baseUrl, tokenMap);
          mcp.mcpPlugin.register(app, store, webhooks, baseUrl, tokenMap);
        },
        seed(store: Store, baseUrl: string): void {
          mod.githubPlugin.seed?.(store, baseUrl);
        },
      };
      return {
        plugin: githubWithMcpPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        createAppKeyResolver(store: Store): AppKeyResolver {
          return (appId: number) => {
            try {
              const gh = mod.getGitHubStore(store);
              const ghApp = gh.apps.all().find((a) => a.app_id === appId);
              if (!ghApp) return null;
              return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
            } catch {
              return null;
            }
          };
        },
        ensureUser(store: Store, baseUrl: string, login: string): number {
          mod.seedFromConfig(store, baseUrl, { users: [{ login }] });
          return mod.getGitHubStore(store).users.findOneBy("login", login)?.id ?? 1;
        },
      };
    },
    defaultFallback(cfg) {
      const firstLogin = (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin";
      return { login: firstLogin, id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    },
    initConfig: {
      github: {
        users: [
          {
            login: "octocat",
            name: "The Octocat",
            email: "octocat@github.com",
            bio: "I am the Octocat",
            company: "GitHub",
            location: "San Francisco",
          },
        ],
        orgs: [{ login: "my-org", name: "My Organization", description: "A test organization" }],
        repos: [
          {
            owner: "octocat",
            name: "hello-world",
            description: "My first repository",
            language: "JavaScript",
            topics: ["hello", "world"],
            auto_init: true,
          },
          {
            owner: "my-org",
            name: "org-repo",
            description: "An organization repository",
            language: "TypeScript",
            auto_init: true,
          },
        ],
        oauth_apps: [
          {
            client_id: "Iv1.example_client_id",
            client_secret: "example_client_secret",
            name: "My App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/github"],
          },
        ],
      },
    },
  },

  mcp: {
    label: "GitHub MCP emulator",
    endpoints:
      "streamable HTTP MCP, OAuth protected-resource metadata, authorization-server metadata, dynamic client registration, ID-JAG token exchange",
    async load() {
      const mod = await import("@emulators/mcp");
      const github = await import("@emulators/github");
      return {
        plugin: mod.mcpPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        ensureUser(store: Store, baseUrl: string, login: string): number {
          mod.seedFromConfig(store, baseUrl, { users: [{ login }] });
          return github.getGitHubStore(store).users.findOneBy("login", login)?.id ?? 1;
        },
      };
    },
    defaultFallback(cfg) {
      const firstLogin = (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin";
      return { login: firstLogin, id: 1, scopes: ["repo", "read:user"] };
    },
    initConfig: {
      mcp: {
        auth: "oauth",
        users: [
          {
            login: "octocat",
            name: "The Octocat",
            email: "octocat@github.com",
          },
        ],
        scopes: ["repo", "read:user"],
      },
    },
  },

  google: {
    label: "Google OAuth 2.0 / OpenID Connect + Gmail, Calendar, and Drive emulator",
    endpoints:
      "OAuth authorize, token exchange, userinfo, OIDC discovery, token revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar lists/events/freebusy, Drive files/uploads",
    async load() {
      const mod = await import("@emulators/google");
      return { plugin: mod.googlePlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@gmail.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
    },
    initConfig: {
      google: {
        users: [
          {
            email: "testuser@example.com",
            name: "Test User",
            picture: "https://lh3.googleusercontent.com/a/default-user",
            email_verified: true,
          },
        ],
        oauth_clients: [
          {
            client_id: "example-client-id.apps.googleusercontent.com",
            client_secret: "GOCSPX-example_secret",
            name: "Code App (Google)",
            redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
          },
        ],
        labels: [
          {
            id: "Label_ops",
            user_email: "testuser@example.com",
            name: "Ops/Review",
            color_background: "#DDEEFF",
            color_text: "#111111",
          },
        ],
        messages: [
          {
            id: "msg_welcome",
            user_email: "testuser@example.com",
            from: "welcome@example.com",
            to: "testuser@example.com",
            subject: "Welcome to the Gmail emulator",
            body_text: "You can now test Gmail, Calendar, and Drive flows locally.",
            label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
            date: "2025-01-04T10:00:00.000Z",
          },
        ],
        calendars: [
          {
            id: "primary",
            user_email: "testuser@example.com",
            summary: "testuser@example.com",
            primary: true,
            selected: true,
            time_zone: "UTC",
          },
        ],
        calendar_events: [
          {
            id: "evt_kickoff",
            user_email: "testuser@example.com",
            calendar_id: "primary",
            summary: "Project Kickoff",
            start_date_time: "2025-01-10T09:00:00.000Z",
            end_date_time: "2025-01-10T09:30:00.000Z",
          },
        ],
        drive_items: [
          {
            id: "drv_docs",
            user_email: "testuser@example.com",
            name: "Docs",
            mime_type: "application/vnd.google-apps.folder",
            parent_ids: ["root"],
          },
        ],
      },
    },
  },

  slack: {
    label: "Slack API emulator",
    endpoints:
      "auth, chat, conversations, users, profiles, presence, files, pins, bookmarks, views, reactions, team, OAuth, incoming webhooks, inspector",
    async load() {
      const mod = await import("@emulators/slack");
      return { plugin: mod.slackPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return {
        login: "U000000001",
        id: 1,
        scopes: [],
      };
    },
    initConfig: {
      slack: {
        team: { name: "My Workspace", domain: "my-workspace" },
        users: [
          {
            name: "developer",
            real_name: "Developer",
            email: "dev@example.com",
            profile: {
              title: "Local Developer",
              status_text: "Testing locally",
              status_emoji: ":computer:",
            },
            presence: "active",
          },
        ],
        channels: [
          { name: "general", topic: "General discussion" },
          { name: "random", topic: "Random stuff" },
        ],
        bots: [{ name: "my-bot" }],
        oauth_apps: [
          {
            client_id: "12345.67890",
            client_secret: "example_client_secret",
            app_id: "A000000001",
            name: "My Slack App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/slack"],
            scopes: [
              "chat:write",
              "channels:read",
              "channels:history",
              "channels:join",
              "channels:manage",
              "channels:write",
              "groups:read",
              "groups:history",
              "groups:write",
              "im:read",
              "im:history",
              "im:write",
              "mpim:read",
              "mpim:history",
              "mpim:write",
              "users:read",
              "users:read.email",
              "users.profile:read",
              "users.profile:write",
              "users:write",
              "files:read",
              "files:write",
              "pins:read",
              "pins:write",
              "bookmarks:read",
              "bookmarks:write",
              "reactions:read",
              "reactions:write",
              "team:read",
            ],
            user_scopes: ["users:read", "users.profile:read"],
            bot_name: "my-bot",
          },
        ],
        strict_scopes: false,
      },
    },
  },

  apple: {
    label: "Apple Sign In / OAuth emulator",
    endpoints: "OAuth authorize, token exchange, JWKS",
    async load() {
      const mod = await import("@emulators/apple");
      return { plugin: mod.applePlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@icloud.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "name"] };
    },
    initConfig: {
      apple: {
        users: [{ email: "testuser@icloud.com", name: "Test User" }],
        oauth_clients: [
          {
            client_id: "com.example.app",
            team_id: "TEAM001",
            name: "My Apple App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/apple"],
          },
        ],
      },
    },
  },

  microsoft: {
    label: "Microsoft Entra ID OAuth 2.0 / OpenID Connect emulator",
    endpoints:
      "OAuth authorize, token exchange, userinfo, OIDC discovery, client credentials, Graph users, mail, calendar, and OneDrive",
    async load() {
      const mod = await import("@emulators/microsoft");
      return { plugin: mod.microsoftPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@outlook.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile", "User.Read"] };
    },
    initConfig: {
      microsoft: {
        users: [{ email: "testuser@outlook.com", name: "Test User" }],
        oauth_clients: [
          {
            client_id: "example-client-id",
            client_secret: "example-client-secret",
            name: "My Microsoft App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/microsoft-entra-id"],
          },
        ],
      },
    },
  },

  okta: {
    label: "Okta OAuth 2.0 / OpenID Connect + management API emulator",
    endpoints:
      "OIDC discovery, JWKS, OAuth authorize/token/userinfo/introspect/revoke/logout, users, groups, apps, authorization servers",
    async load() {
      const mod = await import("@emulators/okta");
      return { plugin: mod.oktaPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstLogin =
        (cfg?.users as Array<{ login?: string; email?: string }> | undefined)?.[0]?.login ??
        (cfg?.users as Array<{ login?: string; email?: string }> | undefined)?.[0]?.email ??
        "testuser@okta.local";
      return { login: firstLogin, id: 1, scopes: ["openid", "profile", "email", "groups"] };
    },
    initConfig: {
      okta: {
        users: [{ login: "testuser@okta.local", email: "testuser@okta.local", first_name: "Test", last_name: "User" }],
        groups: [{ name: "Everyone", description: "All users", type: "BUILT_IN", okta_id: "00g_everyone" }],
        authorization_servers: [{ id: "default", name: "default", audiences: ["api://default"] }],
        oauth_clients: [
          {
            client_id: "okta-test-client",
            client_secret: "okta-test-secret",
            name: "Sample OIDC Client",
            redirect_uris: ["http://localhost:3000/callback"],
            auth_server_id: "default",
          },
        ],
      },
    },
  },

  aws: {
    label: "AWS cloud service emulator",
    endpoints:
      "S3 (buckets, objects), SQS (queues, messages), IAM (users, roles, access keys), STS (assume role, caller identity)",
    async load() {
      const mod = await import("@emulators/aws");
      return {
        plugin: mod.awsPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        issueCredential(
          store: Store,
          baseUrl: string,
          _tokenMap: TokenMap,
          request: CredentialRequest,
        ): IssuedCredential {
          const userName = request.login ?? "developer";
          mod.seedFromConfig(store, baseUrl, { iam: { users: [{ user_name: userName, create_access_key: true }] } });
          const user = mod.getAwsStore(store).iamUsers.findOneBy("user_name", userName);
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
      };
    },
    defaultFallback() {
      return { login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] };
    },
    initConfig: {
      aws: {
        region: "us-east-1",
        s3: { buckets: [{ name: "my-app-bucket" }, { name: "my-app-uploads" }] },
        sqs: { queues: [{ name: "my-app-events" }, { name: "my-app-dlq" }] },
        iam: {
          users: [{ user_name: "developer", create_access_key: true }],
          roles: [{ role_name: "lambda-execution-role", description: "Role for Lambda function execution" }],
        },
      },
    },
  },
  resend: {
    label: "Resend email API emulator",
    endpoints: "emails, domains, contacts, API keys, inbox UI",
    async load() {
      const mod = await import("@emulators/resend");
      return { plugin: mod.resendPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "re_test_admin", id: 1, scopes: [] };
    },
    initConfig: {
      resend: {
        domains: [{ name: "example.com", region: "us-east-1" }],
        contacts: [{ email: "test@example.com", first_name: "Test", last_name: "User" }],
      },
    },
  },
  stripe: {
    label: "Stripe payments emulator",
    endpoints:
      "customers, payment methods, customer sessions, payment intents, charges, products, prices, checkout sessions, webhooks",
    async load() {
      const mod = await import("@emulators/stripe");
      return { plugin: mod.stripePlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "sk_test_admin", id: 1, scopes: [] };
    },
    initConfig: {
      stripe: {
        customers: [{ email: "test@example.com", name: "Test Customer" }],
        products: [{ name: "Pro Plan", description: "Monthly pro subscription" }],
        prices: [{ product_name: "Pro Plan", currency: "usd", unit_amount: 2000 }],
      },
    },
  },
  mongoatlas: {
    label: "MongoDB Atlas service emulator",
    endpoints:
      "Atlas Admin API v2 (projects, clusters, database users, databases, collections), Atlas Data API v1 (findOne, find, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, aggregate)",
    async load() {
      const mod = await import("@emulators/mongoatlas");
      return { plugin: mod.mongoatlasPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "admin", id: 1, scopes: [] };
    },
    initConfig: {
      mongoatlas: {
        projects: [{ name: "Project0" }],
        clusters: [{ name: "Cluster0", project: "Project0" }],
        database_users: [{ username: "admin", project: "Project0" }],
        databases: [{ cluster: "Cluster0", name: "test", collections: ["items"] }],
      },
    },
  },
  clerk: {
    label: "Clerk authentication and user management emulator",
    endpoints:
      "OIDC discovery, JWKS, OAuth authorize/token/userinfo, users, email addresses, organizations, memberships, invitations, sessions",
    async load() {
      const mod = await import("@emulators/clerk");
      return { plugin: mod.clerkPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail =
        (cfg?.users as Array<{ email_addresses?: string[] }> | undefined)?.[0]?.email_addresses?.[0] ??
        "test@example.com";
      return { login: firstEmail, id: 1, scopes: [] };
    },
    initConfig: {
      clerk: {
        users: [
          {
            first_name: "Test",
            last_name: "User",
            email_addresses: ["test@example.com"],
            password: "clerk_test_password",
          },
        ],
        organizations: [
          {
            name: "My Company",
            slug: "my-company",
            members: [{ email: "test@example.com", role: "admin" }],
          },
        ],
        oauth_applications: [
          {
            client_id: "clerk_emulate_client",
            client_secret: "clerk_emulate_secret",
            name: "Emulate App",
            redirect_uris: ["http://localhost:3000/api/auth/callback/clerk"],
          },
        ],
      },
    },
  },
  spotify: {
    label: "Spotify Web API emulator",
    endpoints: "client credentials token endpoint, catalog search, artists, albums, and tracks",
    async load() {
      const mod = await import("@emulators/spotify");
      return { plugin: mod.spotifyPlugin, manifest: mod.manifest, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "spotify-app", id: 1, scopes: [] };
    },
    initConfig: {
      spotify: {
        clients: [{ client_id: "demo-client-id", client_secret: "demo-client-secret", name: "Demo App" }],
      },
    },
  },
  x: {
    label: "X (Twitter) API v2 emulator",
    endpoints:
      "OAuth 2.0 authorize/token/revoke (Authorization Code with PKCE + app-only client credentials), users, tweets",
    async load() {
      const mod = await import("@emulators/x");
      return {
        plugin: mod.xPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        ensureUser(store: Store, baseUrl: string, login: string): number {
          mod.seedFromConfig(store, baseUrl, { users: [{ username: login }] });
          return mod.getXStore(store).users.findOneBy("username", login.toLowerCase().replace(/^@/, ""))?.id ?? 1;
        },
      };
    },
    defaultFallback(cfg) {
      const firstUsername = (cfg?.users as Array<{ username?: string }> | undefined)?.[0]?.username ?? "developer";
      return { login: firstUsername, id: 1, scopes: ["tweet.read", "users.read"] };
    },
    initConfig: {
      x: {
        users: [
          {
            username: "developer",
            name: "Developer",
            description: "Building with the X API v2 emulator.",
            verified: true,
            followers_count: 1200,
            following_count: 320,
          },
        ],
        oauth_clients: [
          {
            client_id: "x-confidential-client",
            client_secret: "x-confidential-secret",
            client_type: "confidential",
            name: "My X App (confidential)",
            redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
          },
          {
            client_id: "x-public-client",
            client_type: "public",
            name: "My X App (public)",
            redirect_uris: ["http://localhost:3000/api/auth/callback/twitter"],
          },
        ],
        tweets: [{ text: "Hello from the X API v2 emulator.", author: "developer", like_count: 42, retweet_count: 7 }],
      },
    },
  },
  workos: {
    label: "WorkOS emulator",
    endpoints:
      "AuthKit user management (hosted login, code/refresh grants, sealed-session JWKS), organizations, memberships, invitations, API keys, Vault KV, OAuth authorization server",
    async load() {
      const mod = await import("@emulators/workos");
      return {
        plugin: mod.workosPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
        ensureUser(store: Store, baseUrl: string, login: string): number {
          mod.seedFromConfig(store, baseUrl, { users: [{ email: login }] });
          return mod.getWorkosStore(store).users.findOneBy("email", login)?.id ?? 1;
        },
      };
    },
    defaultFallback() {
      return { login: "sk_emulate_admin", id: 1, scopes: [] };
    },
    initConfig: {
      workos: {
        users: [{ email: "admin@example.com", first_name: "Admin", last_name: "User" }],
        organizations: [{ name: "Acme", members: ["admin@example.com"] }],
      },
    },
  },
  autumn: {
    label: "Autumn billing emulator",
    endpoints: "customers (get_or_create with seedable subscriptions), usage tracking, plans/features/events lists",
    async load() {
      const mod = await import("@emulators/autumn");
      return {
        plugin: mod.autumnPlugin,
        manifest: mod.manifest,
        seedFromConfig: mod.seedFromConfig,
      };
    },
    defaultFallback() {
      return { login: "am_emulate_admin", id: 1, scopes: [] };
    },
    initConfig: {
      autumn: {
        customers: [{ id: "org_paid_example", subscriptions: [{ plan_id: "pro", status: "active" }] }],
      },
    },
  },
};

export const DEFAULT_TOKENS = {
  tokens: {
    test_token_admin: {
      login: "admin",
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    },
    test_token_user1: {
      login: "octocat",
      scopes: ["repo", "user"],
    },
  },
};
