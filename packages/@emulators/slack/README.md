# @emulators/slack

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/slack
```

## Endpoints

### Auth & Chat
- `POST /api/auth.test` — test authentication
- `POST /api/chat.postMessage` — post message with text or rich payload fields (supports threads via `thread_ts` and DM user IDs)
- `POST /api/chat.postEphemeral` — post ephemeral message outside channel history
- `POST /api/chat.update` — update message text and rich payload fields
- `POST /api/chat.delete` — delete message
- `GET /api/chat.getPermalink` / `POST /api/chat.getPermalink` — get message permalink
- `POST /api/chat.scheduleMessage` — schedule pending message
- `POST /api/chat.deleteScheduledMessage` — delete pending scheduled message
- `POST /api/chat.scheduledMessages.list` — list pending scheduled messages
- `POST /api/chat.meMessage` — /me message

### Conversations
- `POST /api/conversations.list` — list conversations (cursor pagination, `types`, `exclude_archived`)
- `POST /api/conversations.info` — get channel info
- `POST /api/conversations.create` — create channel
- `POST /api/conversations.archive` / `conversations.unarchive` — archive/restore channel
- `POST /api/conversations.rename` — rename channel
- `POST /api/conversations.setTopic` / `conversations.setPurpose` — update topic/purpose
- `POST /api/conversations.history` — channel history with rich message fields
- `POST /api/conversations.replies` — thread replies with rich message fields
- `POST /api/conversations.join` / `conversations.leave` — join/leave
- `POST /api/conversations.invite` / `conversations.kick` — manage membership
- `POST /api/conversations.open` / `conversations.close` — open/close DMs and MPIMs
- `POST /api/conversations.mark` — mark read cursor
- `POST /api/conversations.members` — list members

### Users & Reactions
- `POST /api/users.list` — list users (cursor pagination)
- `POST /api/users.info` — get user info
- `POST /api/users.lookupByEmail` — lookup by email
- `GET /api/users.profile.get` / `POST /api/users.profile.get` — get user profile fields
- `POST /api/users.profile.set` — update profile fields, status, and custom fields
- `GET /api/users.getPresence` / `POST /api/users.getPresence` — get active or away presence
- `POST /api/users.setPresence` — set the authed user to away or automatic presence
- `POST /api/reactions.add` / `reactions.remove` / `reactions.get` — manage reactions

### Team, Bots & Webhooks
- `POST /api/team.info` — workspace info
- `POST /api/bots.info` — bot info
- `POST /services/:teamId/:botId/:webhookId` — incoming webhook with text or rich payload fields

### OAuth
- `GET /oauth/v2/authorize` — authorization (shows user picker)
- `POST /api/oauth.v2.access` — token exchange

## Auth

All Web API endpoints require `Authorization: Bearer <token>`. Seeded OAuth apps create local installation state, and the OAuth v2 flow with user picker UI returns Slack-style bot tokens. Scope checks are relaxed by default for local development. Set `strict_scopes: true` in Slack seed config to return Slack-style `missing_scope` errors when a token lacks the required method scope. Supported user and presence checks include `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, and `users:write`.

## Seed Configuration

```yaml
slack:
  team:
    name: My Workspace
    domain: my-workspace
  users:
    - name: developer
      real_name: Developer
      email: dev@example.com
      profile:
        title: Local Developer
        status_text: Testing locally
        status_emoji: ":computer:"
      presence: active
  channels:
    - name: general
      topic: General discussion
    - name: random
      topic: Random stuff
  bots:
    - name: my-bot
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: example_client_secret
      app_id: A000000001
      name: My Slack App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/slack
      scopes:
        - chat:write
        - channels:read
        - users.profile:read
        - users.profile:write
        - users:write
      user_scopes:
        - users:read
        - users.profile:read
      bot_name: my-bot
  tokens:
    - token: xoxb-local-test
      user: developer
      scopes:
        - chat:write
        - channels:read
        - users.profile:read
        - users.profile:write
        - users:write
  strict_scopes: false
```

## Links

- [Full documentation](https://emulate.dev/slack)
- [GitHub](https://github.com/vercel-labs/emulate)
