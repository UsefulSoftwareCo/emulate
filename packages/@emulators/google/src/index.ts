export const serviceName = "google";
export const serviceLabel = "Google OAuth, Gmail, Calendar, and Drive";
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

export interface GoogleUser extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleOAuthClient extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleDraft extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleAttachment extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleHistoryEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleLabel extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleFilter extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleForwardingAddress extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleSendAs extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleCalendar extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleCalendarEventAttendee {
  [key: string]: unknown;
}
export interface GoogleCalendarConferenceEntryPoint {
  [key: string]: unknown;
}
export interface GoogleCalendarEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleDriveItem extends CompatEntity {
  [key: string]: unknown;
}

export interface GoogleSeedUser {
  [key: string]: unknown;
}

export interface GoogleSeedLabel {
  [key: string]: unknown;
}

export interface GoogleSeedMessage {
  [key: string]: unknown;
}

export interface GoogleSeedCalendar {
  [key: string]: unknown;
}

export interface GoogleSeedCalendarEvent {
  [key: string]: unknown;
}

export interface GoogleSeedDriveItem {
  [key: string]: unknown;
}

export interface GoogleSeedConfig {
  [key: string]: unknown;
}

export interface GoogleStore {
  users: CompatCollection<GoogleUser>;
  oauthClients: CompatCollection<GoogleOAuthClient>;
  messages: CompatCollection<GoogleMessage>;
  drafts: CompatCollection<GoogleDraft>;
  attachments: CompatCollection<GoogleAttachment>;
  history: CompatCollection<GoogleHistoryEvent>;
  labels: CompatCollection<GoogleLabel>;
  filters: CompatCollection<GoogleFilter>;
  forwardingAddresses: CompatCollection<GoogleForwardingAddress>;
  sendAs: CompatCollection<GoogleSendAs>;
  calendars: CompatCollection<GoogleCalendar>;
  calendarEvents: CompatCollection<GoogleCalendarEvent>;
  driveItems: CompatCollection<GoogleDriveItem>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getGoogleStore(store: CompatStoreSource): GoogleStore {
  return {
    users: compatCollection<GoogleUser>(store, "google.users", ["uid", "email"]),
    oauthClients: compatCollection<GoogleOAuthClient>(store, "google.oauth_clients", ["client_id"]),
    messages: compatCollection<GoogleMessage>(store, "google.messages", ["gmail_id", "thread_id", "user_email"]),
    drafts: compatCollection<GoogleDraft>(store, "google.drafts", ["gmail_id", "message_gmail_id", "user_email"]),
    attachments: compatCollection<GoogleAttachment>(store, "google.attachments", ["gmail_id", "message_gmail_id", "user_email"]),
    history: compatCollection<GoogleHistoryEvent>(store, "google.history", ["gmail_id", "message_gmail_id", "user_email"]),
    labels: compatCollection<GoogleLabel>(store, "google.labels", ["gmail_id", "user_email", "name"]),
    filters: compatCollection<GoogleFilter>(store, "google.filters", ["gmail_id", "user_email"]),
    forwardingAddresses: compatCollection<GoogleForwardingAddress>(store, "google.forwarding_addresses", ["user_email", "forwarding_email"]),
    sendAs: compatCollection<GoogleSendAs>(store, "google.send_as", ["user_email", "send_as_email"]),
    calendars: compatCollection<GoogleCalendar>(store, "google.calendars", ["google_id", "user_email"]),
    calendarEvents: compatCollection<GoogleCalendarEvent>(store, "google.calendar_events", ["google_id", "calendar_google_id", "user_email"]),
    driveItems: compatCollection<GoogleDriveItem>(store, "google.drive_items", ["google_id", "user_email", "mime_type"]),
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

export const googlePlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: GoogleSeedConfig): void {
  return undefined;
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
