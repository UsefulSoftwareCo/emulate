export const serviceName = "resend";
export const serviceLabel = "Resend email API";
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

export interface ResendEmail extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendDomain extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendApiKey extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendAudience extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendContact extends CompatEntity {
  [key: string]: unknown;
}

export interface ResendSeedConfig {
  [key: string]: unknown;
}

export interface ResendStore {
  emails: CompatCollection<ResendEmail>;
  domains: CompatCollection<ResendDomain>;
  apiKeys: CompatCollection<ResendApiKey>;
  audiences: CompatCollection<ResendAudience>;
  contacts: CompatCollection<ResendContact>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getResendStore(store: CompatStoreSource): ResendStore {
  return {
    emails: compatCollection<ResendEmail>(store, "resend.emails", ["uuid"]),
    domains: compatCollection<ResendDomain>(store, "resend.domains", ["uuid", "name"]),
    apiKeys: compatCollection<ResendApiKey>(store, "resend.api_keys", ["uuid"]),
    audiences: compatCollection<ResendAudience>(store, "resend.audiences", ["uuid"]),
    contacts: compatCollection<ResendContact>(store, "resend.contacts", ["uuid", "audience_id"]),
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

export const resendPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: ResendSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
