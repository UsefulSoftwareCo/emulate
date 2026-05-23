import { Store, type Collection } from "@emulators/core";
import type {
  SlackTeam,
  SlackUser,
  SlackChannel,
  SlackEphemeralMessage,
  SlackMessage,
  SlackScheduledMessage,
  SlackBot,
  SlackOAuthApp,
  SlackInstallation,
  SlackToken,
  SlackIncomingWebhook,
} from "./entities.js";

export interface SlackStore {
  teams: Collection<SlackTeam>;
  users: Collection<SlackUser>;
  channels: Collection<SlackChannel>;
  messages: Collection<SlackMessage>;
  ephemeralMessages: Collection<SlackEphemeralMessage>;
  scheduledMessages: Collection<SlackScheduledMessage>;
  bots: Collection<SlackBot>;
  oauthApps: Collection<SlackOAuthApp>;
  installations: Collection<SlackInstallation>;
  tokens: Collection<SlackToken>;
  incomingWebhooks: Collection<SlackIncomingWebhook>;
}

export function getSlackStore(store: Store): SlackStore {
  return {
    teams: store.collection<SlackTeam>("slack.teams", ["team_id"]),
    users: store.collection<SlackUser>("slack.users", ["user_id", "email"]),
    channels: store.collection<SlackChannel>("slack.channels", ["channel_id", "name"]),
    messages: store.collection<SlackMessage>("slack.messages", ["ts", "channel_id"]),
    ephemeralMessages: store.collection<SlackEphemeralMessage>("slack.ephemeral_messages", [
      "ts",
      "channel_id",
      "target_user",
    ]),
    scheduledMessages: store.collection<SlackScheduledMessage>("slack.scheduled_messages", [
      "scheduled_message_id",
      "channel_id",
    ]),
    bots: store.collection<SlackBot>("slack.bots", ["bot_id"]),
    oauthApps: store.collection<SlackOAuthApp>("slack.oauth_apps", ["client_id"]),
    installations: store.collection<SlackInstallation>("slack.installations", [
      "installation_id",
      "app_id",
      "client_id",
      "team_id",
    ]),
    tokens: store.collection<SlackToken>("slack.tokens", ["token", "user_id", "app_id", "team_id"]),
    incomingWebhooks: store.collection<SlackIncomingWebhook>("slack.incoming_webhooks", ["token"]),
  };
}
