import type { Entity } from "@emulators/core";

export interface MicrosoftUser extends Entity {
  /** Object ID (oid) — unique per-tenant user identifier */
  oid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  /** Microsoft tenant ID */
  tenant_id: string;
  /** User principal name (usually email) */
  preferred_username: string;
  /** Preferred UI language, e.g. "en-US". Defaults to "en-US" when seeded. */
  preferred_language: string;
}

export interface MicrosoftOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  /** Tenant ID this app is registered in */
  tenant_id: string;
}

export interface MicrosoftEmailAddress {
  emailAddress: {
    address: string;
    name?: string | null;
  };
}

export interface MicrosoftMessage extends Entity {
  graph_id: string;
  user_email: string;
  parent_folder_id: string;
  conversation_id: string;
  subject: string;
  body_preview: string;
  body_content_type: "text" | "html";
  body_content: string;
  from_name: string | null;
  from_address: string;
  sender_name: string | null;
  sender_address: string;
  to_recipients: MicrosoftEmailAddress[];
  cc_recipients: MicrosoftEmailAddress[];
  bcc_recipients: MicrosoftEmailAddress[];
  reply_to: MicrosoftEmailAddress[];
  received_date_time: string;
  sent_date_time: string;
  internet_message_id: string;
  is_read: boolean;
  is_draft: boolean;
  importance: "low" | "normal" | "high";
  categories: string[];
  web_link: string | null;
  has_attachments: boolean;
}

export interface MicrosoftCalendar extends Entity {
  graph_id: string;
  user_email: string;
  name: string;
  color: string;
  change_key: string;
  can_edit: boolean;
  can_share: boolean;
  can_view_private_items: boolean;
  is_default: boolean;
}

export interface MicrosoftEventAttendee {
  emailAddress: {
    address: string;
    name?: string | null;
  };
  type?: "required" | "optional" | "resource";
}

export interface MicrosoftEvent extends Entity {
  graph_id: string;
  user_email: string;
  calendar_id: string;
  subject: string;
  body_preview: string;
  body_content_type: "text" | "html";
  body_content: string;
  start_date_time: string;
  start_time_zone: string;
  end_date_time: string;
  end_time_zone: string;
  location: string | null;
  attendees: MicrosoftEventAttendee[];
  organizer_name: string | null;
  organizer_address: string;
  is_cancelled: boolean;
  show_as: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  web_link: string | null;
}

export interface MicrosoftDrive extends Entity {
  graph_id: string;
  user_email: string;
  name: string;
  drive_type: "personal" | "business" | "documentLibrary";
  owner_id: string;
}

export interface MicrosoftDriveItem extends Entity {
  graph_id: string;
  user_email: string;
  drive_id: string;
  name: string;
  parent_id: string | null;
  folder_child_count: number | null;
  file_mime_type: string | null;
  size: number;
  web_url: string | null;
  download_url: string | null;
  etag_id: string;
  etag_version: number;
  ctag_id: string;
  ctag_version: number;
  /** Base64 encoded file bytes. Seed input still accepts plain UTF-8 strings. */
  content: string | null;
  deleted: boolean;
}
