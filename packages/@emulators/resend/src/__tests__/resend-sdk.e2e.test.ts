import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeExternalResendSDK = process.env.RESEND_EMULATOR_E2E_URL ? describe : describe.skip;

async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer re_test_token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return res.json();
}

describeExternalResendSDK("Resend native runtime - real resend SDK E2E", () => {
  let Resend: typeof import("resend").Resend;
  let previousBaseUrl: string | undefined;
  const emulatorUrl = process.env.RESEND_EMULATOR_E2E_URL ?? "";

  beforeAll(async () => {
    previousBaseUrl = process.env.RESEND_BASE_URL;
    process.env.RESEND_BASE_URL = emulatorUrl;
    ({ Resend } = await import("resend"));
  });

  afterAll(() => {
    if (previousBaseUrl === undefined) {
      delete process.env.RESEND_BASE_URL;
    } else {
      process.env.RESEND_BASE_URL = previousBaseUrl;
    }
  });

  it("sends, lists, reads, and cancels emails", async () => {
    const resend = new Resend("re_test_token");

    const sent = await resend.emails.send({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "SDK hello",
      html: "<p>Hello from the SDK</p>",
    });
    expect(sent.error).toBeNull();
    const id = sent.data?.id;
    expect(id).toBeTruthy();

    const fetched = await resend.emails.get(id!);
    expect(fetched.error).toBeNull();
    expect(fetched.data?.subject).toBe("SDK hello");
    expect((fetched.data as any)?.status).toBe("delivered");

    const listed = await resend.emails.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data.some((email) => email.id === id)).toBe(true);

    const scheduled = await resend.emails.send({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "SDK scheduled",
      text: "Scheduled body",
      scheduledAt: "2099-01-01T00:00:00Z",
    });
    expect(scheduled.error).toBeNull();
    const canceled = await resend.emails.cancel(scheduled.data!.id);
    expect(canceled.error).toBeNull();
    expect((canceled.data as any)?.canceled).toBe(true);
  });

  it("batch sends emails", async () => {
    const resend = new Resend("re_test_token");

    const batch = await resend.batch.send([
      { from: "sender@example.com", to: "one@example.com", subject: "SDK batch one" },
      { from: "sender@example.com", to: "two@example.com", subject: "SDK batch two" },
    ]);

    expect(batch.error).toBeNull();
    expect(batch.data?.data).toHaveLength(2);
  });

  it("creates, verifies, lists, and removes domains", async () => {
    const resend = new Resend("re_test_token");
    const name = `sdk-${Date.now()}.example.com`;

    const created = await resend.domains.create({ name });
    expect(created.error).toBeNull();
    expect(created.data?.name).toBe(name);
    expect(created.data?.status).toBe("pending");

    const verified = await resend.domains.verify(created.data!.id);
    expect(verified.error).toBeNull();
    expect((verified.data as any)?.status).toBe("verified");

    const listed = await resend.domains.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data.some((domain) => domain.id === created.data!.id)).toBe(true);

    const removed = await resend.domains.remove(created.data!.id);
    expect(removed.error).toBeNull();
    expect(removed.data?.deleted).toBe(true);
  });

  it("creates, lists, and removes API keys", async () => {
    const resend = new Resend("re_test_token");

    const created = await resend.apiKeys.create({ name: "SDK key" });
    expect(created.error).toBeNull();
    expect(created.data?.token).toMatch(/^re_/);

    const listed = await resend.apiKeys.list();
    expect(listed.error).toBeNull();
    const listedKey = listed.data?.data.find((key) => key.id === created.data!.id);
    expect(listedKey?.name).toBe("SDK key");
    expect("token" in (listedKey as Record<string, unknown>)).toBe(false);

    const removed = await resend.apiKeys.remove(created.data!.id);
    expect(removed.error).toBeNull();
    expect((removed.data as any)?.deleted).toBe(true);
  });

  it("creates and removes legacy audience contacts", async () => {
    const resend = new Resend("re_test_token");
    const audience = await postJSON(`${emulatorUrl}/audiences`, { name: "SDK audience" });
    const audienceId = String(audience.id);

    const created = await resend.contacts.create({
      audienceId,
      email: "sdk-contact@example.com",
      firstName: "SDK",
      lastName: "Contact",
    });
    expect(created.error).toBeNull();
    expect((created.data as any)?.email).toBe("sdk-contact@example.com");

    const removed = await resend.contacts.remove({ audienceId, id: created.data!.id });
    expect(removed.error).toBeNull();
    expect(removed.data?.deleted).toBe(true);
  });
});
