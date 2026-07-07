import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, WebhookDispatcher, TokenMap } from "@emulators/core";
import type { VercelDeployment, VercelEnvVar, VercelProject } from "./entities.js";
import { getVercelStore } from "./store.js";
import { generateUid, nowMs } from "./helpers.js";
import { userRoutes } from "./routes/user.js";
import { projectsRoutes } from "./routes/projects.js";
import { deploymentsRoutes } from "./routes/deployments.js";
import { domainsRoutes } from "./routes/domains.js";
import { envRoutes } from "./routes/env.js";
import { oauthRoutes } from "./routes/oauth.js";
import { apiKeysRoutes } from "./routes/api-keys.js";
import { openapiRoutes } from "./routes/openapi.js";

export { getVercelStore, type VercelStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface VercelSeedConfig {
  port?: number;
  users?: Array<{
    username: string;
    email?: string;
    name?: string;
  }>;
  teams?: Array<{
    slug: string;
    name?: string;
    description?: string;
  }>;
  projects?: Array<{
    name: string;
    team?: string;
    framework?: string;
    buildCommand?: string;
    outputDirectory?: string;
    rootDirectory?: string;
    nodeVersion?: string;
    deployments?: Array<{
      name?: string;
      target?: "production" | "preview" | "staging";
      runtimeActivity?: boolean;
    }>;
    envVars?: Array<{
      key: string;
      value: string;
      type?: string;
      target?: string[];
    }>;
  }>;
  integrations?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
}

function primaryHostFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.hostname && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return u.hostname;
    }
  } catch {
    /* ignore */
  }
  return "vercel.app";
}

function deploymentHostname(name: string, uid: string, baseUrl: string): string {
  const slug = `${name}-${uid.slice(4, 12)}`;
  return `${slug}.${primaryHostFromBaseUrl(baseUrl)}`;
}

function productionProjectAlias(projectName: string, baseUrl: string): string {
  return `${projectName}.${primaryHostFromBaseUrl(baseUrl)}`;
}

function targetKey(target: VercelDeployment["target"]): "production" | "preview" | "staging" {
  if (target === "production") return "production";
  if (target === "staging") return "staging";
  return "preview";
}

function upsertProjectDeploymentRefs(
  vs: ReturnType<typeof getVercelStore>,
  projectId: number,
  dep: VercelDeployment,
): void {
  const project = vs.projects.get(projectId);
  if (!project) return;
  const createdAt = new Date(dep.created_at).getTime();
  const entry = { id: dep.uid, url: dep.url, state: dep.state, createdAt };
  const latest = [{ ...entry }, ...project.latestDeployments.filter((d) => d.id !== dep.uid)];
  const targets = { ...project.targets };
  targets[targetKey(dep.target)] = { ...entry };
  vs.projects.update(project.id, { latestDeployments: latest, targets });
}

function seedDeployment(
  vs: ReturnType<typeof getVercelStore>,
  baseUrl: string,
  project: VercelProject,
  input: { name?: string; target?: "production" | "preview" | "staging"; runtimeActivity?: boolean },
): void {
  const user = vs.users.all()[0];
  if (!user) return;

  const name = input.name ?? project.name;
  const uid = generateUid("dpl");
  const url = deploymentHostname(name, uid, baseUrl);
  const target = input.target ?? "preview";
  const t = nowMs();
  const dep = vs.deployments.insert({
    uid,
    name,
    url,
    projectId: project.uid,
    source: "seed",
    target,
    readyState: "READY",
    readySubstate: null,
    state: "READY",
    runtimeActivity: input.runtimeActivity ?? true,
    creatorId: user.uid,
    inspectorUrl: `${baseUrl.replace(/\/$/, "")}/deployments/${uid}`,
    meta: {},
    gitSource: null,
    buildingAt: t,
    readyAt: t,
    canceledAt: null,
    errorCode: null,
    errorMessage: null,
    regions: ["iad1"],
    functions: null,
    routes: null,
    plan: "hobby",
    aliasAssigned: true,
    aliasError: null,
    bootedAt: t,
  });

  vs.deploymentAliases.insert({
    uid: generateUid("als"),
    alias: url,
    deploymentId: dep.uid,
    projectId: project.uid,
  });

  if (target === "production") {
    vs.deploymentAliases.insert({
      uid: generateUid("als"),
      alias: productionProjectAlias(project.name, baseUrl),
      deploymentId: dep.uid,
      projectId: project.uid,
    });
  }

  upsertProjectDeploymentRefs(vs, project.id, dep);
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const vs = getVercelStore(store);

  vs.users.insert({
    uid: generateUid("user"),
    email: "admin@localhost",
    username: "admin",
    name: "Admin",
    avatar: null,
    defaultTeamId: null,
    softBlock: null,
    billing: { plan: "hobby", period: null, trial: null, cancelation: null, addons: null },
    resourceConfig: { nodeType: "Edge Functions", concurrentBuilds: 1 },
    stagingPrefix: "staging",
    version: null,
  });
}

export function seedFromConfig(store: Store, baseUrl: string, config: VercelSeedConfig): void {
  const vs = getVercelStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = vs.users.findOneBy("username", u.username);
      if (existing) continue;
      vs.users.insert({
        uid: generateUid("user"),
        email: u.email ?? `${u.username}@localhost`,
        username: u.username,
        name: u.name ?? null,
        avatar: null,
        defaultTeamId: null,
        softBlock: null,
        billing: { plan: "hobby", period: null, trial: null, cancelation: null, addons: null },
        resourceConfig: { nodeType: "Edge Functions", concurrentBuilds: 1 },
        stagingPrefix: "staging",
        version: null,
      });
    }
  }

  if (config.teams) {
    for (const t of config.teams) {
      const existing = vs.teams.findOneBy("slug", t.slug);
      if (existing) continue;

      const firstUser = vs.users.all()[0];
      const creatorId = firstUser?.uid ?? "unknown";

      const team = vs.teams.insert({
        uid: generateUid("team"),
        slug: t.slug,
        name: t.name ?? t.slug,
        avatar: null,
        description: t.description ?? null,
        creatorId,
        membership: { confirmed: true, role: "OWNER" },
        billing: { plan: "pro", period: null, trial: null, cancelation: null, addons: null },
        resourceConfig: { nodeType: "Edge Functions", concurrentBuilds: 1 },
        stagingPrefix: "staging",
      });

      for (const u of vs.users.all()) {
        const role = u.uid === creatorId ? "OWNER" : "MEMBER";
        vs.teamMembers.insert({
          teamId: team.uid,
          userId: u.uid,
          role,
          confirmed: true,
          joinedFrom: "seed",
        });
      }
    }
  }

  if (config.projects) {
    for (const p of config.projects) {
      let accountId: string;
      if (p.team) {
        const team = vs.teams.findOneBy("slug", p.team);
        if (!team) continue;
        accountId = team.uid;
      } else {
        const user = vs.users.all()[0];
        if (!user) continue;
        accountId = user.uid;
      }

      const existingByName = vs.projects.findBy("name", p.name);
      if (existingByName.some((proj) => proj.accountId === accountId)) continue;

      const project = vs.projects.insert({
        uid: generateUid("prj"),
        name: p.name,
        accountId,
        framework: p.framework ?? null,
        buildCommand: p.buildCommand ?? null,
        devCommand: null,
        installCommand: null,
        outputDirectory: p.outputDirectory ?? null,
        rootDirectory: p.rootDirectory ?? null,
        commandForIgnoringBuildStep: null,
        nodeVersion: p.nodeVersion ?? "20.x",
        serverlessFunctionRegion: null,
        publicSource: false,
        autoAssignCustomDomains: true,
        autoAssignCustomDomainsUpdatedBy: null,
        gitForkProtection: true,
        sourceFilesOutsideRootDirectory: false,
        live: true,
        link: null,
        latestDeployments: [],
        targets: {},
        protectionBypass: {},
        passwordProtection: null,
        ssoProtection: null,
        trustedIps: null,
        connectConfigurationId: null,
        gitComments: { onPullRequest: true, onCommit: false },
        webAnalytics: null,
        speedInsights: null,
        oidcTokenConfig: null,
        tier: "hobby",
      });

      if (p.envVars) {
        for (const ev of p.envVars) {
          vs.envVars.insert({
            uid: generateUid("env"),
            projectId: project.uid,
            key: ev.key,
            value: ev.value,
            type: (ev.type ?? "encrypted") as VercelEnvVar["type"],
            target: (ev.target ?? ["production", "preview", "development"]) as VercelEnvVar["target"],
            gitBranch: null,
            customEnvironmentIds: [],
            comment: null,
            decrypted: false,
          });
        }
      }

      if (p.deployments) {
        for (const deployment of p.deployments) {
          seedDeployment(vs, baseUrl, project, deployment);
        }
      }
    }
  }

  if (config.integrations) {
    for (const integ of config.integrations) {
      const existing = vs.integrations.findOneBy("client_id", integ.client_id);
      if (existing) continue;
      vs.integrations.insert({
        client_id: integ.client_id,
        client_secret: integ.client_secret,
        name: integ.name,
        redirect_uris: integ.redirect_uris,
      });
    }
  }
}

export const vercelPlugin: ServicePlugin = {
  name: "vercel",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    userRoutes(ctx);
    projectsRoutes(ctx);
    deploymentsRoutes(ctx);
    domainsRoutes(ctx);
    envRoutes(ctx);
    apiKeysRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default vercelPlugin;
