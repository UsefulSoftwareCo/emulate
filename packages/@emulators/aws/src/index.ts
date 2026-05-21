export const serviceName = "aws";
export const serviceLabel = "AWS cloud services";
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

export interface S3Bucket extends CompatEntity {
  [key: string]: unknown;
}
export interface S3Object extends CompatEntity {
  [key: string]: unknown;
}
export interface SqsQueue extends CompatEntity {
  [key: string]: unknown;
}
export interface SqsMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface IamUser extends CompatEntity {
  [key: string]: unknown;
}
export interface IamRole extends CompatEntity {
  [key: string]: unknown;
}

export interface AwsSeedConfig {
  [key: string]: unknown;
}

export interface AwsStore {
  s3Buckets: CompatCollection<S3Bucket>;
  s3Objects: CompatCollection<S3Object>;
  sqsQueues: CompatCollection<SqsQueue>;
  sqsMessages: CompatCollection<SqsMessage>;
  iamUsers: CompatCollection<IamUser>;
  iamRoles: CompatCollection<IamRole>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getAwsStore(store: CompatStoreSource): AwsStore {
  return {
    s3Buckets: compatCollection<S3Bucket>(store, "aws.s3_buckets", ["bucket_name"]),
    s3Objects: compatCollection<S3Object>(store, "aws.s3_objects", ["key", "bucket_name"]),
    sqsQueues: compatCollection<SqsQueue>(store, "aws.sqs_queues", ["queue_name", "queue_url"]),
    sqsMessages: compatCollection<SqsMessage>(store, "aws.sqs_messages", ["message_id", "queue_name"]),
    iamUsers: compatCollection<IamUser>(store, "aws.iam_users", ["user_name", "user_id"]),
    iamRoles: compatCollection<IamRole>(store, "aws.iam_roles", ["role_name", "role_id"]),
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

export const awsPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: AwsSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
