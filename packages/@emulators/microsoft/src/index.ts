import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getMicrosoftStore, type MicrosoftStore } from "./store.js";
import type { MicrosoftUser } from "./entities.js";
import { generateOid, DEFAULT_TENANT_ID } from "./helpers.js";
import {
  createCalendarRecord,
  createDriveItemRecord,
  createDriveRecord,
  createEventRecord,
  createMessageRecord,
  emailAddress,
} from "./helpers.js";
import { graphRoutes } from "./routes/graph.js";
import { oauthRoutes } from "./routes/oauth.js";
import { openapiRoutes } from "./routes/openapi.js";

export { getMicrosoftStore, type MicrosoftStore } from "./store.js";
export * from "./entities.js";
export { manifest } from "./manifest.js";

export interface MicrosoftSeedConfig {
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    tenant_id?: string;
    preferred_language?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    tenant_id?: string;
  }>;
  messages?: Array<{
    id?: string;
    user_email?: string;
    subject?: string;
    body?: string;
    from?: string;
    from_name?: string;
    to?: string[];
    is_read?: boolean;
  }>;
  calendars?: Array<{
    id?: string;
    user_email?: string;
    name: string;
    is_default?: boolean;
  }>;
  events?: Array<{
    id?: string;
    user_email?: string;
    calendar_id?: string;
    subject?: string;
    body?: string;
    start_date_time: string;
    end_date_time: string;
    location?: string;
    attendees?: Array<{ address: string; name?: string }>;
  }>;
  drives?: Array<{
    id?: string;
    user_email?: string;
    name?: string;
  }>;
  drive_items?: Array<{
    id?: string;
    user_email?: string;
    drive_id?: string;
    name: string;
    parent_id?: string | null;
    folder?: boolean;
    mime_type?: string;
    content?: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ms = getMicrosoftStore(store);

  const user = ms.users.insert({
    oid: generateOid(),
    email: "testuser@outlook.com",
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    email_verified: true,
    tenant_id: DEFAULT_TENANT_ID,
    preferred_username: "testuser@outlook.com",
    preferred_language: "en-US",
  });
  seedGraphDefaultsForUser(ms, user, true);
}

function seedGraphDefaultsForUser(ms: MicrosoftStore, user: MicrosoftUser, stableIds = false): void {
  if (ms.messages.findBy("user_email", user.email).length === 0) {
    createMessageRecord(ms, {
      graph_id: stableIds ? "msg_welcome" : undefined,
      user_email: user.email,
      subject: "Welcome to Microsoft Graph",
      body_content: "This is a seeded message from the Microsoft emulator.",
      from_name: "Microsoft Emulator",
      from_address: "microsoft-emulator@example.com",
      to_recipients: [emailAddress(user.email, user.name)],
      is_read: false,
    });
  }

  let calendar = ms.calendars.findBy("user_email", user.email).find((candidate) => candidate.is_default);
  if (!calendar) {
    calendar = createCalendarRecord(ms, {
      graph_id: stableIds ? "cal_primary" : undefined,
      user_email: user.email,
      name: "Calendar",
      is_default: true,
    });
  }
  calendar = ms.calendars.findBy("user_email", user.email).find((candidate) => candidate.is_default);
  if (calendar && ms.events.findBy("user_email", user.email).length === 0) {
    createEventRecord(ms, {
      graph_id: stableIds ? "evt_standup" : undefined,
      user_email: user.email,
      calendar_id: calendar.graph_id,
      subject: "Daily Standup",
      body_content: "Team sync",
      start_date_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      end_date_time: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      attendees: [emailAddress("teammate@example.com", "Teammate")],
      organizer_name: user.name,
      organizer_address: user.email,
    });
  }

  let drive = ms.drives.findBy("user_email", user.email)[0];
  if (!drive) {
    drive = createDriveRecord(ms, {
      graph_id: stableIds ? "drv_default" : undefined,
      user_email: user.email,
      name: "OneDrive",
      owner_id: user.oid,
    });
  }
  const rootId = stableIds ? "root" : `${drive.graph_id}_root`;
  if (!ms.driveItems.findBy("drive_id", drive.graph_id).some((item) => item.parent_id === null)) {
    createDriveItemRecord(ms, {
      graph_id: rootId,
      user_email: user.email,
      drive_id: drive.graph_id,
      name: "root",
      parent_id: null,
      folder_child_count: 2,
    });
  }
  const root = ms.driveItems.findBy("drive_id", drive.graph_id).find((item) => item.parent_id === null);
  if (root && !ms.driveItems.findBy("drive_id", drive.graph_id).some((item) => item.parent_id === root.graph_id)) {
    createDriveItemRecord(ms, {
      graph_id: stableIds ? "item_documents" : undefined,
      user_email: user.email,
      drive_id: drive.graph_id,
      name: "Documents",
      parent_id: root.graph_id,
      folder_child_count: 1,
    });
  }
  const documents = ms.driveItems
    .findBy("drive_id", drive.graph_id)
    .find((item) => item.name === "Documents" && item.user_email === user.email);
  if (
    documents &&
    !ms.driveItems.findBy("parent_id", documents.graph_id).some((item) => item.name === "Project Notes.txt")
  ) {
    createDriveItemRecord(ms, {
      graph_id: stableIds ? "item_notes" : undefined,
      user_email: user.email,
      drive_id: drive.graph_id,
      name: "Project Notes.txt",
      parent_id: documents.graph_id,
      file_mime_type: "text/plain",
      content: "Seeded Microsoft emulator file.",
    });
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: MicrosoftSeedConfig): void {
  const ms = getMicrosoftStore(store);

  if (config.users) {
    for (const u of config.users) {
      const existing = ms.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      const user = ms.users.insert({
        oid: generateOid(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        email_verified: true,
        tenant_id: u.tenant_id ?? DEFAULT_TENANT_ID,
        preferred_username: u.email,
        preferred_language: u.preferred_language ?? "en-US",
      });
      seedGraphDefaultsForUser(ms, user);
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = ms.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      ms.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
        tenant_id: client.tenant_id ?? DEFAULT_TENANT_ID,
      });
    }
  }

  // Resources that omit an explicit user_email attach to the user this seed
  // config introduced, not whatever default user the plugin seeded first.
  // Seed authors mint their delegated token for their own seeded user, so a
  // drive item (or message/event) without user_email must land on that user's
  // drive to stay visible under /me.
  const firstConfigUserEmail = config.users?.[0]?.email;
  const firstUser = ms.users.all()[0];
  const defaultUserEmail = firstConfigUserEmail ?? firstUser?.email ?? "testuser@outlook.com";

  if (config.calendars) {
    for (const calendar of config.calendars) {
      const userEmail = calendar.user_email ?? defaultUserEmail;
      if (calendar.id && ms.calendars.findOneBy("graph_id", calendar.id)) continue;
      createCalendarRecord(ms, {
        graph_id: calendar.id,
        user_email: userEmail,
        name: calendar.name,
        is_default: calendar.is_default,
      });
    }
  }

  if (config.messages) {
    for (const message of config.messages) {
      const userEmail = message.user_email ?? defaultUserEmail;
      if (message.id && ms.messages.findOneBy("graph_id", message.id)) continue;
      createMessageRecord(ms, {
        graph_id: message.id,
        user_email: userEmail,
        subject: message.subject,
        body_content: message.body,
        from_address: message.from,
        from_name: message.from_name,
        to_recipients: (message.to ?? [userEmail]).map((address) => emailAddress(address)),
        is_read: message.is_read,
      });
    }
  }

  if (config.events) {
    for (const event of config.events) {
      const userEmail = event.user_email ?? defaultUserEmail;
      if (event.id && ms.events.findOneBy("graph_id", event.id)) continue;
      const calendar =
        (event.calendar_id ? ms.calendars.findOneBy("graph_id", event.calendar_id) : undefined) ??
        ms.calendars.findBy("user_email", userEmail).find((candidate) => candidate.is_default) ??
        ms.calendars.findBy("user_email", userEmail)[0] ??
        createCalendarRecord(ms, { user_email: userEmail, name: "Calendar", is_default: true });
      createEventRecord(ms, {
        graph_id: event.id,
        user_email: userEmail,
        calendar_id: calendar.graph_id,
        subject: event.subject,
        body_content: event.body,
        start_date_time: event.start_date_time,
        end_date_time: event.end_date_time,
        location: event.location,
        attendees: (event.attendees ?? []).map((attendee) => emailAddress(attendee.address, attendee.name)),
        organizer_name: ms.users.findOneBy("email", userEmail)?.name ?? userEmail,
        organizer_address: userEmail,
      });
    }
  }

  if (config.drives) {
    for (const driveSeed of config.drives) {
      const userEmail = driveSeed.user_email ?? defaultUserEmail;
      if (driveSeed.id && ms.drives.findOneBy("graph_id", driveSeed.id)) continue;
      const owner = ms.users.findOneBy("email", userEmail);
      const drive = createDriveRecord(ms, {
        graph_id: driveSeed.id,
        user_email: userEmail,
        name: driveSeed.name ?? "OneDrive",
        owner_id: owner?.oid ?? generateOid(),
      });
      if (!ms.driveItems.findBy("drive_id", drive.graph_id).some((item) => item.parent_id === null)) {
        createDriveItemRecord(ms, {
          graph_id: drive.graph_id === "drv_default" ? "root" : `${drive.graph_id}_root`,
          user_email: userEmail,
          drive_id: drive.graph_id,
          name: "root",
          parent_id: null,
          folder_child_count: 0,
        });
      }
    }
  }

  if (config.drive_items) {
    for (const item of config.drive_items) {
      const userEmail = item.user_email ?? defaultUserEmail;
      if (item.id && ms.driveItems.findOneBy("graph_id", item.id)) continue;
      const owner = ms.users.findOneBy("email", userEmail);
      const drive =
        (item.drive_id ? ms.drives.findOneBy("graph_id", item.drive_id) : undefined) ??
        ms.drives.findBy("user_email", userEmail)[0] ??
        createDriveRecord(ms, { user_email: userEmail, name: "OneDrive", owner_id: owner?.oid ?? generateOid() });
      const root =
        ms.driveItems.findBy("drive_id", drive.graph_id).find((candidate) => candidate.parent_id === null) ??
        createDriveItemRecord(ms, {
          graph_id: `${drive.graph_id}_root`,
          user_email: userEmail,
          drive_id: drive.graph_id,
          name: "root",
          parent_id: null,
          folder_child_count: 0,
        });
      createDriveItemRecord(ms, {
        graph_id: item.id,
        user_email: userEmail,
        drive_id: drive.graph_id,
        name: item.name,
        parent_id: item.parent_id === undefined ? root.graph_id : item.parent_id,
        folder_child_count: item.folder ? 0 : null,
        file_mime_type: item.folder ? null : (item.mime_type ?? "application/octet-stream"),
        content: item.content,
      });
    }
  }
}

export const microsoftPlugin: ServicePlugin = {
  name: "microsoft",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    graphRoutes(ctx);
    openapiRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default microsoftPlugin;
