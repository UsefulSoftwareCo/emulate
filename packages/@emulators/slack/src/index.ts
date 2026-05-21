export const serviceName = "slack";
export const serviceLabel = "Slack Web API, OAuth, and webhooks";
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

export interface SlackTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackUser extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackChannel extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackBot extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackOAuthApp extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackIncomingWebhook extends CompatEntity {
  [key: string]: unknown;
}

export interface SlackSeedConfig {
  [key: string]: unknown;
}

export interface SlackStore {
  teams: CompatCollection<SlackTeam>;
  users: CompatCollection<SlackUser>;
  channels: CompatCollection<SlackChannel>;
  messages: CompatCollection<SlackMessage>;
  bots: CompatCollection<SlackBot>;
  oauthApps: CompatCollection<SlackOAuthApp>;
  incomingWebhooks: CompatCollection<SlackIncomingWebhook>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getSlackStore(store: CompatStoreSource): SlackStore {
  return {
    teams: compatCollection<SlackTeam>(store, "slack.teams", ["team_id"]),
    users: compatCollection<SlackUser>(store, "slack.users", ["user_id", "email"]),
    channels: compatCollection<SlackChannel>(store, "slack.channels", ["channel_id", "name"]),
    messages: compatCollection<SlackMessage>(store, "slack.messages", ["ts", "channel_id"]),
    bots: compatCollection<SlackBot>(store, "slack.bots", ["bot_id"]),
    oauthApps: compatCollection<SlackOAuthApp>(store, "slack.oauth_apps", ["client_id"]),
    incomingWebhooks: compatCollection<SlackIncomingWebhook>(store, "slack.incoming_webhooks", ["token"]),
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

export const slackPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: SlackSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
