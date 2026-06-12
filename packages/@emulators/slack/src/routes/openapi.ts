import type { RouteContext } from "@emulators/core";

// OpenAPI 3.1 document for this Slack emulator instance, pointed at itself,
// with the bearer-token security scheme real Slack uses. Covers the
// hand-authored Web API surface (see manifest.ts); unsupported operations are
// omitted so OpenAPI-aware clients only see what actually works.
export function openapiRoutes({ app, baseUrl }: RouteContext): void {
  app.get("/openapi.json", (c) => c.json(buildSpec(baseUrl)));
}

// Every Web API method responds 200 with { ok: boolean, ... }; failures come
// back as { ok: false, error } rather than non-2xx statuses.
const ok = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
  },
});
// Slack methods accept form-encoded bodies (the SDK default) or JSON.
const slackBody = (properties: Record<string, unknown>, required: readonly string[], description: string) => {
  const schema = { type: "object", properties, required: [...required] };
  return {
    required: required.length > 0,
    description,
    content: {
      "application/x-www-form-urlencoded": { schema },
      "application/json": { schema },
    },
  };
};
const channel = { type: "string", description: "Channel ID (or name for chat methods)." };
const cursor = { type: "string", description: "Pagination cursor from response_metadata.next_cursor." };
const limit = { type: "integer", description: "Page size, capped at 1000." };
// In form bodies, blocks/attachments arrive as JSON-encoded strings.
const jsonArray = (description: string) => ({
  type: ["array", "string"],
  items: { type: "object" },
  description: `${description} (array, or JSON-encoded string in form bodies).`,
});
const richMessageFields = {
  blocks: jsonArray("Layout blocks"),
  attachments: jsonArray("Legacy attachments"),
};

function buildSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Slack Web API (Emulated)",
      version: "1.0.0",
      description:
        "Emulated subset of the Slack Web API. Authenticate with a bearer bot token (mint one at POST /_emulate/credentials, or use a seeded token). Methods return 200 with { ok: false, error } on failure.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Slack token, sent as `Authorization: Bearer xoxb-…`.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/auth.test": {
        post: {
          operationId: "auth.test",
          tags: ["auth"],
          summary: "Check the token and return user/team identity",
          responses: { "200": ok("Identity for the authed token.") },
        },
      },
      "/api/chat.postMessage": {
        post: {
          operationId: "chat.postMessage",
          tags: ["chat"],
          summary: "Send a message to a channel",
          requestBody: slackBody(
            {
              channel,
              text: { type: "string" },
              thread_ts: { type: "string", description: "Parent message ts to reply in a thread." },
              ...richMessageFields,
              metadata: { type: ["object", "string"] },
              parse: { type: "string" },
              username: { type: "string" },
              icon_url: { type: "string" },
              icon_emoji: { type: "string" },
            },
            ["channel"],
            "The message to post. Requires text, blocks, or attachments.",
          ),
          responses: { "200": ok("The posted message with channel and ts.") },
        },
      },
      "/api/chat.postEphemeral": {
        post: {
          operationId: "chat.postEphemeral",
          tags: ["chat"],
          summary: "Send an ephemeral message to a user in a channel",
          requestBody: slackBody(
            {
              channel,
              user: { type: "string", description: "User ID who sees the message." },
              text: { type: "string" },
              thread_ts: { type: "string" },
              ...richMessageFields,
            },
            ["channel", "user"],
            "The ephemeral message. Requires text, blocks, or attachments.",
          ),
          responses: { "200": ok("The ephemeral message_ts.") },
        },
      },
      "/api/chat.update": {
        post: {
          operationId: "chat.update",
          tags: ["chat"],
          summary: "Update an existing message",
          requestBody: slackBody(
            {
              channel,
              ts: { type: "string", description: "Timestamp of the message to update." },
              text: { type: "string" },
              ...richMessageFields,
            },
            ["channel", "ts"],
            "The updated content.",
          ),
          responses: { "200": ok("The updated message.") },
        },
      },
      "/api/chat.delete": {
        post: {
          operationId: "chat.delete",
          tags: ["chat"],
          summary: "Delete a message",
          requestBody: slackBody({ channel, ts: { type: "string" } }, ["channel", "ts"], "The message to delete."),
          responses: { "200": ok("Deletion confirmation.") },
        },
      },
      "/api/chat.getPermalink": {
        post: {
          operationId: "chat.getPermalink",
          tags: ["chat"],
          summary: "Get a permalink for a message",
          requestBody: slackBody(
            { channel, message_ts: { type: "string" } },
            ["channel", "message_ts"],
            "The message to link to.",
          ),
          responses: { "200": ok("The permalink.") },
        },
      },
      "/api/chat.scheduleMessage": {
        post: {
          operationId: "chat.scheduleMessage",
          tags: ["chat"],
          summary: "Schedule a message for later delivery",
          requestBody: slackBody(
            {
              channel,
              text: { type: "string" },
              post_at: { type: "integer", description: "Unix timestamp (seconds) to post at." },
              thread_ts: { type: "string" },
              ...richMessageFields,
            },
            ["channel", "post_at"],
            "The message to schedule. Requires text, blocks, or attachments.",
          ),
          responses: { "200": ok("The scheduled_message_id and post_at.") },
        },
      },
      "/api/conversations.list": {
        post: {
          operationId: "conversations.list",
          tags: ["conversations"],
          summary: "List conversations",
          requestBody: slackBody(
            {
              types: {
                type: "string",
                description: "Comma-separated: public_channel, private_channel, im, mpim. Defaults to public_channel.",
              },
              exclude_archived: { type: ["boolean", "string"] },
              limit,
              cursor,
            },
            [],
            "Listing filters.",
          ),
          responses: { "200": ok("Channel list with response_metadata.next_cursor.") },
        },
      },
      "/api/conversations.info": {
        post: {
          operationId: "conversations.info",
          tags: ["conversations"],
          summary: "Get a conversation's details",
          requestBody: slackBody({ channel }, ["channel"], "The conversation to look up."),
          responses: { "200": ok("The channel object.") },
        },
      },
      "/api/conversations.create": {
        post: {
          operationId: "conversations.create",
          tags: ["conversations"],
          summary: "Create a channel",
          requestBody: slackBody(
            {
              name: { type: "string", description: "Channel name (lowercase letters, digits, - and _)." },
              is_private: { type: ["boolean", "string"] },
            },
            ["name"],
            "The channel to create.",
          ),
          responses: { "200": ok("The created channel.") },
        },
      },
      "/api/conversations.history": {
        post: {
          operationId: "conversations.history",
          tags: ["conversations"],
          summary: "Fetch a conversation's message history",
          requestBody: slackBody({ channel, limit, cursor }, ["channel"], "The conversation to read."),
          responses: { "200": ok("Messages, has_more, and response_metadata.next_cursor.") },
        },
      },
      "/api/conversations.replies": {
        post: {
          operationId: "conversations.replies",
          tags: ["conversations"],
          summary: "Fetch a thread of messages",
          requestBody: slackBody(
            { channel, ts: { type: "string", description: "Parent message ts." } },
            ["channel", "ts"],
            "The thread to read.",
          ),
          responses: { "200": ok("The thread messages.") },
        },
      },
      "/api/conversations.join": {
        post: {
          operationId: "conversations.join",
          tags: ["conversations"],
          summary: "Join a channel",
          requestBody: slackBody({ channel }, ["channel"], "The channel to join."),
          responses: { "200": ok("The joined channel.") },
        },
      },
      "/api/conversations.invite": {
        post: {
          operationId: "conversations.invite",
          tags: ["conversations"],
          summary: "Invite users to a channel",
          requestBody: slackBody(
            {
              channel,
              users: { type: "string", description: "Comma-separated user IDs (up to 100)." },
            },
            ["channel", "users"],
            "The users to invite.",
          ),
          responses: { "200": ok("The updated channel.") },
        },
      },
      "/api/conversations.members": {
        post: {
          operationId: "conversations.members",
          tags: ["conversations"],
          summary: "List members of a conversation",
          requestBody: slackBody({ channel }, ["channel"], "The conversation to list."),
          responses: { "200": ok("Member user IDs.") },
        },
      },
      "/api/users.list": {
        post: {
          operationId: "users.list",
          tags: ["users"],
          summary: "List workspace users",
          requestBody: slackBody({ limit, cursor }, [], "Pagination options."),
          responses: { "200": ok("Member list with response_metadata.next_cursor.") },
        },
      },
      "/api/users.info": {
        post: {
          operationId: "users.info",
          tags: ["users"],
          summary: "Get a user's details",
          requestBody: slackBody({ user: { type: "string" } }, ["user"], "The user to look up."),
          responses: { "200": ok("The user object.") },
        },
      },
      "/api/users.lookupByEmail": {
        post: {
          operationId: "users.lookupByEmail",
          tags: ["users"],
          summary: "Find a user by email",
          requestBody: slackBody({ email: { type: "string" } }, ["email"], "The email to look up."),
          responses: { "200": ok("The matching user.") },
        },
      },
      "/api/users.profile.get": {
        post: {
          operationId: "users.profile.get",
          tags: ["users"],
          summary: "Get a user's profile",
          requestBody: slackBody(
            { user: { type: "string", description: "Defaults to the authed user." } },
            [],
            "The user whose profile to read.",
          ),
          responses: { "200": ok("The profile.") },
        },
      },
      "/api/users.profile.set": {
        post: {
          operationId: "users.profile.set",
          tags: ["users"],
          summary: "Set a user's profile fields",
          requestBody: slackBody(
            {
              user: { type: "string", description: "Defaults to the authed user." },
              profile: {
                type: ["object", "string"],
                description: "Profile fields to merge (object, or JSON-encoded string in form bodies).",
              },
              name: { type: "string", description: "Single field name (alternative to profile)." },
              value: { type: "string", description: "Single field value (used with name)." },
            },
            [],
            "Either a profile object or a name/value pair.",
          ),
          responses: { "200": ok("The updated profile.") },
        },
      },
      "/api/users.getPresence": {
        post: {
          operationId: "users.getPresence",
          tags: ["users"],
          summary: "Get a user's presence",
          requestBody: slackBody(
            { user: { type: "string", description: "Defaults to the authed user." } },
            [],
            "The user whose presence to read.",
          ),
          responses: { "200": ok("The presence state.") },
        },
      },
      "/api/users.setPresence": {
        post: {
          operationId: "users.setPresence",
          tags: ["users"],
          summary: "Set the authed user's presence",
          requestBody: slackBody(
            { presence: { type: "string", enum: ["auto", "away"] } },
            ["presence"],
            "The manual presence to set.",
          ),
          responses: { "200": ok("Confirmation.") },
        },
      },
      "/api/reactions.add": {
        post: {
          operationId: "reactions.add",
          tags: ["reactions"],
          summary: "Add a reaction to a message",
          requestBody: slackBody(
            {
              channel,
              timestamp: { type: "string", description: "Message ts to react to." },
              name: { type: "string", description: "Emoji name without colons." },
            },
            ["channel", "timestamp", "name"],
            "The reaction to add.",
          ),
          responses: { "200": ok("Confirmation.") },
        },
      },
      "/api/reactions.remove": {
        post: {
          operationId: "reactions.remove",
          tags: ["reactions"],
          summary: "Remove a reaction from a message",
          requestBody: slackBody(
            {
              channel,
              timestamp: { type: "string" },
              name: { type: "string", description: "Emoji name without colons." },
            },
            ["channel", "timestamp", "name"],
            "The reaction to remove.",
          ),
          responses: { "200": ok("Confirmation.") },
        },
      },
      "/api/reactions.get": {
        post: {
          operationId: "reactions.get",
          tags: ["reactions"],
          summary: "Get reactions for a message",
          requestBody: slackBody(
            { channel, timestamp: { type: "string" } },
            ["channel", "timestamp"],
            "The message to inspect.",
          ),
          responses: { "200": ok("The message with its reactions.") },
        },
      },
      "/api/pins.add": {
        post: {
          operationId: "pins.add",
          tags: ["pins"],
          summary: "Pin a message to a channel",
          requestBody: slackBody(
            { channel, timestamp: { type: "string", description: "Message ts to pin." } },
            ["channel", "timestamp"],
            "The message to pin.",
          ),
          responses: { "200": ok("Confirmation.") },
        },
      },
      "/api/pins.list": {
        post: {
          operationId: "pins.list",
          tags: ["pins"],
          summary: "List pinned items in a channel",
          requestBody: slackBody({ channel }, ["channel"], "The channel to list."),
          responses: { "200": ok("Pinned items.") },
        },
      },
      "/api/pins.remove": {
        post: {
          operationId: "pins.remove",
          tags: ["pins"],
          summary: "Unpin a message from a channel",
          requestBody: slackBody(
            { channel, timestamp: { type: "string" } },
            ["channel", "timestamp"],
            "The message to unpin.",
          ),
          responses: { "200": ok("Confirmation.") },
        },
      },
      "/api/bookmarks.add": {
        post: {
          operationId: "bookmarks.add",
          tags: ["bookmarks"],
          summary: "Add a bookmark to a channel",
          requestBody: slackBody(
            {
              channel_id: { type: "string" },
              title: { type: "string" },
              type: { type: "string", enum: ["link"] },
              link: { type: "string", description: "http(s) URL to bookmark." },
              emoji: { type: "string" },
              access_level: { type: "string", enum: ["read", "write"] },
              parent_id: { type: "string" },
            },
            ["channel_id", "title", "type", "link"],
            "The bookmark to add.",
          ),
          responses: { "200": ok("The created bookmark.") },
        },
      },
      "/api/bookmarks.list": {
        post: {
          operationId: "bookmarks.list",
          tags: ["bookmarks"],
          summary: "List bookmarks in a channel",
          requestBody: slackBody({ channel_id: { type: "string" } }, ["channel_id"], "The channel to list."),
          responses: { "200": ok("Bookmark list.") },
        },
      },
      "/api/files.getUploadURLExternal": {
        post: {
          operationId: "files.getUploadURLExternal",
          tags: ["files"],
          summary: "Get an upload URL for a file",
          requestBody: slackBody(
            {
              filename: { type: "string" },
              length: { type: "integer", description: "File size in bytes." },
              alt_text: { type: "string" },
              snippet_type: { type: "string" },
            },
            ["filename", "length"],
            "The file to stage. POST the raw bytes to the returned upload_url, then call files.completeUploadExternal.",
          ),
          responses: { "200": ok("The upload_url and file_id.") },
        },
      },
      "/api/files.completeUploadExternal": {
        post: {
          operationId: "files.completeUploadExternal",
          tags: ["files"],
          summary: "Finalize staged uploads and share them",
          requestBody: slackBody(
            {
              files: {
                type: ["array", "string"],
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, title: { type: "string" } },
                  required: ["id"],
                },
                description: "Staged files to complete (array, or JSON-encoded string in form bodies).",
              },
              channel_id: { type: "string", description: "Channel or user ID to share into." },
              channels: { type: "string", description: "Comma-separated channel IDs to share into." },
              initial_comment: { type: "string" },
              thread_ts: { type: "string" },
              blocks: jsonArray("Layout blocks for the share message"),
            },
            ["files"],
            "The staged uploads to finalize.",
          ),
          responses: { "200": ok("The completed file objects.") },
        },
      },
      "/api/files.list": {
        post: {
          operationId: "files.list",
          tags: ["files"],
          summary: "List files",
          requestBody: slackBody(
            {
              channel: { type: "string", description: "Filter to files visible in this channel." },
              user: { type: "string", description: "Filter to files uploaded by this user." },
              types: { type: "string", description: "Comma-separated file types. Defaults to all." },
              ts_from: { type: ["number", "string"] },
              ts_to: { type: ["number", "string"] },
              page: { type: "integer" },
              count: { type: "integer", description: "Page size, capped at 1000." },
            },
            [],
            "Listing filters.",
          ),
          responses: { "200": ok("Files with paging info.") },
        },
      },
      "/api/views.publish": {
        post: {
          operationId: "views.publish",
          tags: ["views"],
          summary: "Publish a user's App Home view",
          requestBody: slackBody(
            {
              user_id: { type: "string" },
              view: {
                type: ["object", "string"],
                description: "Home view payload (object, or JSON-encoded string in form bodies).",
              },
              hash: { type: "string", description: "Expected current view hash for conflict detection." },
            },
            ["user_id", "view"],
            "The home view to publish.",
          ),
          responses: { "200": ok("The published view.") },
        },
      },
      "/api/views.open": {
        post: {
          operationId: "views.open",
          tags: ["views"],
          summary: "Open a modal view",
          requestBody: slackBody(
            {
              trigger_id: { type: "string", description: "Short-lived trigger from an interaction." },
              interactivity_pointer: { type: "string", description: "Alternative to trigger_id." },
              view: {
                type: ["object", "string"],
                description: "Modal view payload (object, or JSON-encoded string in form bodies).",
              },
            },
            ["view"],
            "The modal to open. Requires trigger_id or interactivity_pointer.",
          ),
          responses: { "200": ok("The opened view.") },
        },
      },
      "/api/team.info": {
        post: {
          operationId: "team.info",
          tags: ["team"],
          summary: "Get workspace info",
          responses: { "200": ok("The team object.") },
        },
      },
      "/api/bots.info": {
        post: {
          operationId: "bots.info",
          tags: ["team"],
          summary: "Get a bot's details",
          requestBody: slackBody({ bot: { type: "string", description: "Bot ID." } }, ["bot"], "The bot to look up."),
          responses: { "200": ok("The bot object.") },
        },
      },
      "/api/oauth.v2.access": {
        post: {
          operationId: "oauth.v2.access",
          tags: ["oauth"],
          summary: "Exchange an OAuth v2 authorization code for tokens",
          security: [],
          requestBody: slackBody(
            {
              code: { type: "string" },
              client_id: { type: "string", description: "May also be sent via HTTP Basic auth." },
              client_secret: { type: "string", description: "May also be sent via HTTP Basic auth." },
              redirect_uri: { type: "string" },
            },
            ["code"],
            "The authorization code exchange.",
          ),
          responses: { "200": ok("Bot and user access tokens.") },
        },
      },
    },
  };
}
