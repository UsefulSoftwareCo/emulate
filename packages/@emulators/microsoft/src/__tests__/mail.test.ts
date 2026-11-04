import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "@emulators/core";
import { manifest, microsoftPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
type Message = {
  id: string;
  conversationId: string;
  body: { content: string };
  toRecipients: unknown[];
  [key: string]: unknown;
};
type AttachmentCollection = { value: Array<{ id: string }> };

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>;
}
const address = (email: string) => ({ emailAddress: { address: email } });
const file = {
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "proposal.bin",
  contentType: "application/octet-stream",
  contentBytes: "AP9iaW5hcnkNCg==",
};

describe("Microsoft draft mail", () => {
  let server: ReturnType<typeof createServer>;

  beforeEach(() => {
    server = createServer(microsoftPlugin, {
      baseUrl: base,
      manifest,
      tokens: {
        writer: { login: "alice@example.com", id: 1, scopes: ["Mail.ReadWrite", "Mail.Send"] },
        reader: { login: "alice@example.com", id: 1, scopes: ["Mail.Read"] },
        editor: { login: "alice@example.com", id: 1, scopes: ["Mail.ReadWrite"] },
        sender: { login: "alice@example.com", id: 1, scopes: ["Mail.Send"] },
        other: { login: "bob@example.com", id: 2, scopes: ["Mail.ReadWrite", "Mail.Send"] },
        app: { login: "application", id: 0, scopes: ["https://graph.microsoft.com/.default"] },
      },
    });
    seedFromConfig(server.store, base, {
      users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      messages: [
        { id: "original", user_email: "alice@example.com", subject: "Proposal", from: "customer@example.com" },
      ],
    });
  });

  function request(path: string, method = "GET", body?: unknown, token = "writer") {
    return server.app.request(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: 'IdType="ImmutableId"',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function draft(extra: Record<string, unknown> = {}) {
    const res = await request("/v1.0/me/messages", "POST", {
      subject: "Proposal",
      body: { contentType: "HTML", content: "<p>Hello</p>" },
      toRecipients: [address("customer@example.com")],
      ccRecipients: [address("colleague@example.com")],
      bccRecipients: [address("archive@example.com")],
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ id: string; conversationId: string; [key: string]: unknown }>;
  }

  it("creates a draft with binary attachments, sends it once, and retains its immutable identity", async () => {
    const message = await draft({ attachments: [file] });
    expect(message).toMatchObject({
      isDraft: true,
      parentFolderId: "drafts",
      hasAttachments: true,
      body: { contentType: "html", content: "<p>Hello</p>" },
      bccRecipients: [address("archive@example.com")],
    });
    const path = `/v1.0/me/messages/${message.id}`;
    const attachments = await json<AttachmentCollection>(request(`${path}/attachments`));
    expect(attachments.value).toHaveLength(1);
    expect(attachments.value[0]).toMatchObject({ ...file, size: 10, isInline: false });
    const attachmentPath = `${path}/attachments/${attachments.value[0].id}`;
    expect(await (await request(attachmentPath)).json()).toMatchObject(file);
    const raw = await request(`${attachmentPath}/$value`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 98, 105, 110, 97, 114, 121, 13, 10]),
    );

    const sent = await request(`${path}/send`, "POST");
    expect(sent.status).toBe(202);
    expect(await sent.text()).toBe("");
    expect(await (await request(path)).json()).toMatchObject({
      id: message.id,
      conversationId: message.conversationId,
      isDraft: false,
      parentFolderId: "sentitems",
      hasAttachments: true,
      bccRecipients: [address("archive@example.com")],
    });
    expect((await request(`${path}/send`, "POST")).status).toBe(400);
    expect((await request(`${path}/attachments`, "POST", file)).status).toBe(400);
    const ledger = await json<{ entries: unknown[] }>(request("/_emulate/ledger"));
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "message_Create", response: expect.objectContaining({ status: 201 }) }),
        expect.objectContaining({
          operationId: "message_Send",
          response: expect.objectContaining({ status: 202 }),
          sideEffects: expect.arrayContaining([
            expect.objectContaining({ collection: "microsoft.messages", id: message.id }),
          ]),
        }),
      ]),
    );
  });

  it("creates a reply, patches it without replacing identity or recipients, attaches a file, and sends", async () => {
    const original = await json<Message>(request("/v1.0/me/messages/original"));
    const res = await request("/v1.0/me/messages/original/createReply", "POST", {});
    expect(res.status).toBe(201);
    const reply = await json<Message>(res);
    expect(reply).toMatchObject({
      isDraft: true,
      subject: "RE: Proposal",
      conversationId: original.conversationId,
      toRecipients: [address("customer@example.com")],
      hasAttachments: false,
    });
    expect(reply.id).not.toBe(original.id);
    const path = `/v1.0/me/messages/${reply.id}`;
    const patch = await request(path, "PATCH", {
      body: { contentType: "html", content: "<p>Reply</p>" },
      ccRecipients: [],
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      id: reply.id,
      conversationId: original.conversationId,
      subject: "RE: Proposal",
      toRecipients: reply.toRecipients,
      ccRecipients: [],
      body: { contentType: "html", content: "<p>Reply</p>" },
      bodyPreview: "Reply",
    });
    const attached = await request(`${path}/attachments`, "POST", file);
    expect(attached.status).toBe(201);
    expect(await attached.json()).toMatchObject(file);
    expect((await request(`${path}/send`, "POST")).status).toBe(202);
    expect(await (await request(path)).json()).toMatchObject({ isDraft: false, hasAttachments: true });
    expect(await (await request("/v1.0/me/messages/original")).json()).toEqual(original);
  });

  it("uses replyTo, accepts comment or message.body, and does not copy original attachments", async () => {
    const original = await draft({ replyTo: [address("support@example.com")], attachments: [file] });
    await request(`/v1.0/me/messages/${original.id}/send`, "POST");
    const path = `/v1.0/me/messages/${original.id}/createReply`;
    const res = await request(path, "POST", { comment: "Thanks" });
    expect(res.status).toBe(201);
    const reply = await json<Message>(res);
    expect(reply).toMatchObject({ toRecipients: [address("support@example.com")], hasAttachments: false });
    expect(reply.body.content).toContain("Thanks");
    const bodyReply = await request(path, "POST", {
      message: { body: { contentType: "text", content: "Different reply" } },
    });
    expect(bodyReply.status).toBe(201);
    expect((await json<Message>(bodyReply)).body.content).toBe("Different reply");
    expect(
      (await request(path, "POST", { comment: "One", message: { body: { contentType: "text", content: "Two" } } }))
        .status,
    ).toBe(400);
    expect((await request(path, "POST")).status).toBe(201);
  });

  it("keeps the draft and attachments after an injected send failure", async () => {
    const message = await draft({ attachments: [file] });
    const path = `/v1.0/me/messages/${message.id}`;
    const fault = await request("/_emulate/faults", "POST", {
      match: { operationId: "message_Send" },
      response: { status: 503, body: { error: "temporary" } },
    });
    expect(fault.status).toBe(200);
    expect((await request(`${path}/send`, "POST")).status).toBe(503);
    expect(await (await request(path)).json()).toMatchObject({ isDraft: true, hasAttachments: true });
    expect((await json<AttachmentCollection>(request(`${path}/attachments`))).value).toHaveLength(1);
    expect((await request(`${path}/send`, "POST")).status).toBe(202);
  });

  it("checks delegated scopes and isolates messages and attachment bytes by mailbox", async () => {
    const message = await draft({ attachments: [file] });
    const path = `/v1.0/me/messages/${message.id}`;
    const {
      value: [attachment],
    } = await json<AttachmentCollection>(request(`${path}/attachments`));
    const operations: Array<[string, string, unknown?]> = [
      [path, "GET"],
      [path, "PATCH", { subject: "Changed" }],
      [`${path}/createReply`, "POST", {}],
      [`${path}/send`, "POST"],
      [`${path}/attachments`, "GET"],
      [`${path}/attachments`, "POST", file],
      [`${path}/attachments/${attachment.id}`, "GET"],
      [`${path}/attachments/${attachment.id}/$value`, "GET"],
    ];
    for (const [url, method, body] of operations) {
      expect((await request(url, method, body, "other")).status).toBe(404);
      expect((await request(url, method, body, "app")).status).toBe(403);
      expect((await request(url, method, body, "invalid")).status).toBe(401);
    }
    for (const token of ["reader", "sender", "app"]) {
      expect((await request("/v1.0/me/messages", "POST", {}, token)).status).toBe(403);
    }
    expect((await request(path, "PATCH", { subject: "Changed" }, "reader")).status).toBe(403);
    expect((await request(`${path}/attachments`, "POST", file, "reader")).status).toBe(403);
    expect((await request(`${path}/createReply`, "POST", {}, "reader")).status).toBe(403);
    expect((await request(`${path}/send`, "POST", undefined, "editor")).status).toBe(403);
    expect((await request(`${path}/send`, "POST", undefined, "sender")).status).toBe(202);
    const second = await draft();
    expect((await request(`/v1.0/me/messages/${second.id}/attachments/${attachment.id}/$value`)).status).toBe(404);
  });

  it("rejects invalid attachments atomically and requires the attachment endpoint for PATCH", async () => {
    const before = (await json<{ value: Message[] }>(request("/v1.0/me/messages"))).value.length;
    for (const attachments of [
      [file, { ...file, contentBytes: "not base64!" }],
      [{ ...file, "@odata.type": "#microsoft.graph.itemAttachment" }],
    ]) {
      expect((await request("/v1.0/me/messages", "POST", { attachments })).status).toBe(400);
    }
    expect((await json<{ value: Message[] }>(request("/v1.0/me/messages"))).value).toHaveLength(before);
    const message = await draft();
    const path = `/v1.0/me/messages/${message.id}`;
    expect((await request(path, "PATCH", { subject: "Should not change", attachments: [file] })).status).toBe(400);
    expect(
      (
        await request(`${path}/attachments`, "POST", {
          ...file,
          contentBytes: Buffer.alloc(3 * 1024 * 1024).toString("base64"),
        })
      ).status,
    ).toBe(400);
    expect((await json<AttachmentCollection>(request(`${path}/attachments`))).value).toEqual([]);
    expect(await (await request(path)).json()).toMatchObject({ subject: "Proposal", hasAttachments: false });
    const malformed = await server.app.request(`${base}/v1.0/me/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer writer", "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  it("does not count inline-only attachments and rejects sending without recipients", async () => {
    const message = await draft({
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
      attachments: [{ ...file, isInline: true, contentId: "logo" }],
    });
    expect(message.hasAttachments).toBe(false);
    expect((await request(`/v1.0/me/messages/${message.id}/send`, "POST")).status).toBe(400);
    expect(await (await request(`/v1.0/me/messages/${message.id}`)).json()).toMatchObject({ isDraft: true });
  });

  it("accepts file bytes immediately below the simple attachment size limit", async () => {
    const message = await draft();
    const contentBytes = Buffer.alloc(3 * 1024 * 1024 - 1, 255).toString("base64");
    const res = await request(`/v1.0/me/messages/${message.id}/attachments`, "POST", { ...file, contentBytes });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ size: 3 * 1024 * 1024 - 1, contentBytes });
  });

  it("preserves disjoint draft edits when requests arrive together", async () => {
    const message = await draft();
    const path = `/v1.0/me/messages/${message.id}`;
    const results = await Promise.all([
      request(path, "PATCH", { subject: "Updated subject" }),
      request(path, "PATCH", { body: { contentType: "text", content: "Updated body" } }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(await (await request(path)).json()).toMatchObject({
      subject: "Updated subject",
      body: { contentType: "text", content: "Updated body" },
    });
  });
});
