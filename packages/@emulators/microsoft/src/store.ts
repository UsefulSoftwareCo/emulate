import { Store, type Collection } from "@emulators/core";
import type {
  MicrosoftCalendar,
  MicrosoftDrive,
  MicrosoftDriveItem,
  MicrosoftEvent,
  MicrosoftMessage,
  MicrosoftOAuthClient,
  MicrosoftUser,
} from "./entities.js";

export interface MicrosoftStore {
  users: Collection<MicrosoftUser>;
  oauthClients: Collection<MicrosoftOAuthClient>;
  messages: Collection<MicrosoftMessage>;
  calendars: Collection<MicrosoftCalendar>;
  events: Collection<MicrosoftEvent>;
  drives: Collection<MicrosoftDrive>;
  driveItems: Collection<MicrosoftDriveItem>;
}

export function getMicrosoftStore(store: Store): MicrosoftStore {
  return {
    users: store.collection<MicrosoftUser>("microsoft.users", ["oid", "email"]),
    oauthClients: store.collection<MicrosoftOAuthClient>("microsoft.oauth_clients", ["client_id"]),
    messages: store.collection<MicrosoftMessage>("microsoft.messages", ["graph_id", "user_email"]),
    calendars: store.collection<MicrosoftCalendar>("microsoft.calendars", ["graph_id", "user_email"]),
    events: store.collection<MicrosoftEvent>("microsoft.events", ["graph_id", "calendar_id", "user_email"]),
    drives: store.collection<MicrosoftDrive>("microsoft.drives", ["graph_id", "user_email"]),
    driveItems: store.collection<MicrosoftDriveItem>("microsoft.drive_items", [
      "graph_id",
      "drive_id",
      "parent_id",
      "user_email",
    ]),
  };
}
