import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebClient } from "@slack/web-api";
import { getSlackStore } from "../index.js";
import { slackTestToken, startSlackTestEmulator, type SlackTestEmulator } from "./helpers.js";

describe("Slack plugin - real @slack/web-api WebClient baseline", () => {
  let emulator: SlackTestEmulator;
  let client: WebClient;

  beforeAll(async () => {
    emulator = await startSlackTestEmulator(({ store }) => {
      getSlackStore(store).bots.insert({
        bot_id: "B000000001",
        name: "test-bot",
        deleted: false,
        icons: { image_48: "" },
      });
    });

    client = new WebClient(slackTestToken, {
      slackApiUrl: `${emulator.url}/api/`,
    });
  });

  afterAll(async () => {
    await emulator.close();
  });

  it("calls auth.test and team.info through the Slack SDK", async () => {
    const auth = await client.auth.test();
    expect(auth.ok).toBe(true);
    expect(auth.user_id).toBe("U000000001");

    const team = await client.team.info();
    expect(team.ok).toBe(true);
    expect(team.team?.name).toBe("Emulate");
  });

  it("round trips chat writes and conversation reads through the Slack SDK", async () => {
    const created = await client.conversations.create({ name: "sdk-baseline" });
    expect(created.ok).toBe(true);
    const channel = created.channel?.id;
    expect(channel).toBeDefined();

    const posted = await client.chat.postMessage({ channel: channel!, text: "hello from WebClient" });
    expect(posted.ok).toBe(true);
    expect(posted.ts).toBeDefined();

    const updated = await client.chat.update({ channel: channel!, ts: posted.ts!, text: "updated from WebClient" });
    expect(updated.ok).toBe(true);
    expect(updated.text).toBe("updated from WebClient");

    const history = await client.conversations.history({ channel: channel! });
    expect(history.ok).toBe(true);
    expect(history.messages?.[0]?.text).toBe("updated from WebClient");

    const reply = await client.chat.postMessage({
      channel: channel!,
      text: "reply from WebClient",
      thread_ts: posted.ts,
    });
    expect(reply.ok).toBe(true);

    const replies = await client.conversations.replies({ channel: channel!, ts: posted.ts! });
    expect(replies.ok).toBe(true);
    expect(replies.messages?.map((message) => message.text)).toEqual([
      "updated from WebClient",
      "reply from WebClient",
    ]);

    const deleted = await client.chat.delete({ channel: channel!, ts: posted.ts! });
    expect(deleted.ok).toBe(true);
  });

  it("exercises conversation membership through the Slack SDK", async () => {
    const created = await client.conversations.create({ name: "sdk-membership" });
    const channel = created.channel!.id!;

    const leave = await client.conversations.leave({ channel });
    expect(leave.ok).toBe(true);

    const join = await client.conversations.join({ channel });
    expect(join.ok).toBe(true);
    expect((join.channel as { num_members?: number } | undefined)?.num_members).toBe(1);

    const members = await client.conversations.members({ channel });
    expect(members.ok).toBe(true);
    expect(members.members).toContain("U000000001");

    const list = await client.conversations.list();
    expect(list.ok).toBe(true);
    expect(list.channels?.map((ch) => ch.name)).toContain("sdk-membership");
  });

  it("exercises users, reactions, and bots through the Slack SDK", async () => {
    const channel = getSlackStore(emulator.store).channels.findOneBy("name", "general")!.channel_id;
    const posted = await client.chat.postMessage({ channel, text: "react via WebClient" });

    await expect(client.reactions.add({ channel, timestamp: posted.ts!, name: "thumbsup" })).resolves.toMatchObject({
      ok: true,
    });

    const reactions = await client.reactions.get({ channel, timestamp: posted.ts! });
    expect(reactions.ok).toBe(true);
    expect(reactions.message?.reactions?.[0]?.name).toBe("thumbsup");

    await expect(client.reactions.remove({ channel, timestamp: posted.ts!, name: "thumbsup" })).resolves.toMatchObject({
      ok: true,
    });

    const users = await client.users.list({});
    expect(users.ok).toBe(true);
    expect(users.members?.map((user) => user.id)).toContain("U000000001");

    const user = await client.users.info({ user: "U000000001" });
    expect(user.ok).toBe(true);
    expect(user.user?.name).toBe("admin");

    const byEmail = await client.users.lookupByEmail({ email: "admin@emulate.dev" });
    expect(byEmail.ok).toBe(true);
    expect(byEmail.user?.id).toBe("U000000001");

    const bot = await client.bots.info({ bot: "B000000001" });
    expect(bot.ok).toBe(true);
    expect(bot.bot?.name).toBe("test-bot");
  });
});
