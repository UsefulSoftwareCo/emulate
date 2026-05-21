export const serviceName = "clerk";
export const serviceLabel = "Clerk authentication and user management";
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

export interface ClerkUser extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkEmailAddress extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganization extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganizationMembership extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganizationInvitation extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkSession extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOAuthApplication extends CompatEntity {
  [key: string]: unknown;
}

export interface ClerkSeedConfig {
  [key: string]: unknown;
}

export interface ClerkStore {
  users: CompatCollection<ClerkUser>;
  emailAddresses: CompatCollection<ClerkEmailAddress>;
  organizations: CompatCollection<ClerkOrganization>;
  memberships: CompatCollection<ClerkOrganizationMembership>;
  invitations: CompatCollection<ClerkOrganizationInvitation>;
  sessions: CompatCollection<ClerkSession>;
  oauthApps: CompatCollection<ClerkOAuthApplication>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getClerkStore(store: CompatStoreSource): ClerkStore {
  return {
    users: compatCollection<ClerkUser>(store, "clerk.users", ["clerk_id", "username"]),
    emailAddresses: compatCollection<ClerkEmailAddress>(store, "clerk.emails", ["email_id", "user_id", "email_address"]),
    organizations: compatCollection<ClerkOrganization>(store, "clerk.orgs", ["clerk_id", "slug"]),
    memberships: compatCollection<ClerkOrganizationMembership>(store, "clerk.memberships", ["membership_id", "org_id", "user_id"]),
    invitations: compatCollection<ClerkOrganizationInvitation>(store, "clerk.invitations", ["invitation_id", "org_id"]),
    sessions: compatCollection<ClerkSession>(store, "clerk.sessions", ["clerk_id", "user_id"]),
    oauthApps: compatCollection<ClerkOAuthApplication>(store, "clerk.oauth_apps", ["app_id", "client_id"]),
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

export const clerkPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: ClerkSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
