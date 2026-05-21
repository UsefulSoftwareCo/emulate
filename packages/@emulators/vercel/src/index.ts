export const serviceName = "vercel";
export const serviceLabel = "Vercel API";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export interface VercelUser extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelTeamMember extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelProject extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeployment extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentAlias extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelBuild extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelFile extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentFile extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDomain extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelEnvVar extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelProtectionBypass extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelApiKey extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelIntegration extends CompatEntity {
  [key: string]: unknown;
}

export interface VercelSeedConfig {
  [key: string]: unknown;
}

export interface VercelStore {
  users: CompatCollection<VercelUser>;
  teams: CompatCollection<VercelTeam>;
  teamMembers: CompatCollection<VercelTeamMember>;
  projects: CompatCollection<VercelProject>;
  deployments: CompatCollection<VercelDeployment>;
  deploymentAliases: CompatCollection<VercelDeploymentAlias>;
  builds: CompatCollection<VercelBuild>;
  deploymentEvents: CompatCollection<VercelDeploymentEvent>;
  files: CompatCollection<VercelFile>;
  deploymentFiles: CompatCollection<VercelDeploymentFile>;
  domains: CompatCollection<VercelDomain>;
  envVars: CompatCollection<VercelEnvVar>;
  protectionBypasses: CompatCollection<VercelProtectionBypass>;
  apiKeys: CompatCollection<VercelApiKey>;
  integrations: CompatCollection<VercelIntegration>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getVercelStore(store: CompatStoreSource): VercelStore {
  return {
    users: compatCollection<VercelUser>(store, "vercel.users", ["uid", "username"]),
    teams: compatCollection<VercelTeam>(store, "vercel.teams", ["uid", "slug"]),
    teamMembers: compatCollection<VercelTeamMember>(store, "vercel.team_members", ["teamId", "userId"]),
    projects: compatCollection<VercelProject>(store, "vercel.projects", ["uid", "name", "accountId"]),
    deployments: compatCollection<VercelDeployment>(store, "vercel.deployments", ["uid", "projectId", "url"]),
    deploymentAliases: compatCollection<VercelDeploymentAlias>(store, "vercel.deployment_aliases", ["deploymentId", "projectId"]),
    builds: compatCollection<VercelBuild>(store, "vercel.builds", ["deploymentId"]),
    deploymentEvents: compatCollection<VercelDeploymentEvent>(store, "vercel.deployment_events", ["deploymentId"]),
    files: compatCollection<VercelFile>(store, "vercel.files", ["digest"]),
    deploymentFiles: compatCollection<VercelDeploymentFile>(store, "vercel.deployment_files", ["deploymentId"]),
    domains: compatCollection<VercelDomain>(store, "vercel.domains", ["projectId", "name"]),
    envVars: compatCollection<VercelEnvVar>(store, "vercel.env_vars", ["projectId", "uid"]),
    protectionBypasses: compatCollection<VercelProtectionBypass>(store, "vercel.protection_bypasses", ["projectId"]),
    apiKeys: compatCollection<VercelApiKey>(store, "vercel.api_keys", ["uid", "teamId", "userId"]),
    integrations: compatCollection<VercelIntegration>(store, "vercel.integrations", ["client_id"]),
  };
}

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const vercelPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: VercelSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
