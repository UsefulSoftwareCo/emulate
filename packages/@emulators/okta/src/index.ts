export const serviceName = "okta";
export const serviceLabel = "Okta identity provider and management API";
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

export type OktaUserStatus = string;
export type OktaGroupType = string;
export type OktaAppStatus = string;
export type OktaAuthorizationServerStatus = string;

export interface OktaUser extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaGroup extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaApp extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaOAuthClient extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaAuthorizationServer extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaGroupMembership extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaAppAssignment extends CompatEntity {
  [key: string]: unknown;
}

export interface OktaSeedConfig {
  [key: string]: unknown;
}

export interface OktaStore {
  users: CompatCollection<OktaUser>;
  groups: CompatCollection<OktaGroup>;
  apps: CompatCollection<OktaApp>;
  oauthClients: CompatCollection<OktaOAuthClient>;
  authorizationServers: CompatCollection<OktaAuthorizationServer>;
  groupMemberships: CompatCollection<OktaGroupMembership>;
  appAssignments: CompatCollection<OktaAppAssignment>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getOktaStore(store: CompatStoreSource): OktaStore {
  return {
    users: compatCollection<OktaUser>(store, "okta.users", ["okta_id", "login", "email"]),
    groups: compatCollection<OktaGroup>(store, "okta.groups", ["okta_id", "name"]),
    apps: compatCollection<OktaApp>(store, "okta.apps", ["okta_id", "name"]),
    oauthClients: compatCollection<OktaOAuthClient>(store, "okta.oauth_clients", ["client_id", "auth_server_id"]),
    authorizationServers: compatCollection<OktaAuthorizationServer>(store, "okta.auth_servers", ["server_id"]),
    groupMemberships: compatCollection<OktaGroupMembership>(store, "okta.group_memberships", ["group_okta_id", "user_okta_id"]),
    appAssignments: compatCollection<OktaAppAssignment>(store, "okta.app_assignments", ["app_okta_id", "user_okta_id"]),
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

export const oktaPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: OktaSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
