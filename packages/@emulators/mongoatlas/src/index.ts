export const serviceName = "mongoatlas";
export const serviceLabel = "MongoDB Atlas Admin API and Data API";
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

export interface MongoAtlasCluster extends CompatEntity {
  [key: string]: unknown;
}
export interface MongoAtlasDatabase extends CompatEntity {
  [key: string]: unknown;
}
export interface MongoAtlasCollection extends CompatEntity {
  [key: string]: unknown;
}
export interface MongoAtlasDocument extends CompatEntity {
  [key: string]: unknown;
}
export interface MongoAtlasProject extends CompatEntity {
  [key: string]: unknown;
}
export interface MongoAtlasUser extends CompatEntity {
  [key: string]: unknown;
}

export interface MongoAtlasSeedConfig {
  [key: string]: unknown;
}

export interface MongoAtlasStore {
  clusters: CompatCollection<MongoAtlasCluster>;
  databases: CompatCollection<MongoAtlasDatabase>;
  collections: CompatCollection<MongoAtlasCollection>;
  documents: CompatCollection<MongoAtlasDocument>;
  projects: CompatCollection<MongoAtlasProject>;
  users: CompatCollection<MongoAtlasUser>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getMongoAtlasStore(store: CompatStoreSource): MongoAtlasStore {
  return {
    clusters: compatCollection<MongoAtlasCluster>(store, "mongoatlas.clusters", ["cluster_id", "name"]),
    databases: compatCollection<MongoAtlasDatabase>(store, "mongoatlas.databases", ["cluster_id", "name"]),
    collections: compatCollection<MongoAtlasCollection>(store, "mongoatlas.collections", ["cluster_id", "database", "name"]),
    documents: compatCollection<MongoAtlasDocument>(store, "mongoatlas.documents", ["cluster_id", "doc_id"]),
    projects: compatCollection<MongoAtlasProject>(store, "mongoatlas.projects", ["group_id"]),
    users: compatCollection<MongoAtlasUser>(store, "mongoatlas.users", ["user_id", "username"]),
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

export const mongoatlasPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: MongoAtlasSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
