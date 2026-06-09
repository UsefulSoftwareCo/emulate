import type { ServiceManifest } from "@emulators/core";

/**
 * Resend's machine-readable service manifest. This is the single source of truth
 * for Resend's surfaces, auth, specs, seed shape, and copyable connection
 * snippets, consumed by the CLI registry, the Cloudflare host, and the console.
 */
export const manifest: ServiceManifest = {
  id: "resend",
  name: "Resend",
  description: "Stateful Resend emulator for email sending, domains, contacts, audiences, API keys, and an inbox UI.",
  docsUrl: "https://docs.emulators.dev/resend",
  surfaces: [
    { id: "rest", kind: "rest", title: "REST API", status: "partial", basePath: "/" },
    { id: "inbox", kind: "ui", title: "Inbox UI", status: "supported", basePath: "/_inbox" },
    { id: "webhooks", kind: "webhooks", title: "Webhooks", status: "partial" },
  ],
  auth: [{ id: "api-key", title: "Resend API key", type: "api-key", status: "supported" }],
  specs: [
    {
      kind: "openapi",
      title: "Resend REST API subset",
      coverage: "hand-authored",
      operations: [
        { operationId: "emails.send", method: "POST", path: "/emails", status: "hand-authored" },
        { operationId: "emails.sendBatch", method: "POST", path: "/emails/batch", status: "hand-authored" },
        { operationId: "emails.list", method: "GET", path: "/emails", status: "hand-authored" },
        { operationId: "emails.get", method: "GET", path: "/emails/:id", status: "hand-authored" },
        { operationId: "emails.cancel", method: "POST", path: "/emails/:id/cancel", status: "hand-authored" },
        // Real Resend exposes PATCH /emails/:id to reschedule, which the emulator does not implement yet.
        { operationId: "emails.update", method: "PATCH", path: "/emails/:id", status: "unsupported" },
        { operationId: "domains.create", method: "POST", path: "/domains", status: "hand-authored" },
        { operationId: "domains.list", method: "GET", path: "/domains", status: "hand-authored" },
        { operationId: "domains.get", method: "GET", path: "/domains/:id", status: "hand-authored" },
        { operationId: "domains.verify", method: "POST", path: "/domains/:id/verify", status: "hand-authored" },
        { operationId: "domains.remove", method: "DELETE", path: "/domains/:id", status: "hand-authored" },
        // Real Resend exposes PATCH /domains/:id for tracking settings, which the emulator does not implement yet.
        { operationId: "domains.update", method: "PATCH", path: "/domains/:id", status: "unsupported" },
        { operationId: "apiKeys.create", method: "POST", path: "/api-keys", status: "hand-authored" },
        { operationId: "apiKeys.list", method: "GET", path: "/api-keys", status: "hand-authored" },
        { operationId: "apiKeys.remove", method: "DELETE", path: "/api-keys/:id", status: "hand-authored" },
        { operationId: "audiences.create", method: "POST", path: "/audiences", status: "hand-authored" },
        { operationId: "audiences.list", method: "GET", path: "/audiences", status: "hand-authored" },
        { operationId: "audiences.remove", method: "DELETE", path: "/audiences/:id", status: "hand-authored" },
        {
          operationId: "contacts.create",
          method: "POST",
          path: "/audiences/:audience_id/contacts",
          status: "hand-authored",
        },
        {
          operationId: "contacts.list",
          method: "GET",
          path: "/audiences/:audience_id/contacts",
          status: "hand-authored",
        },
        {
          operationId: "contacts.remove",
          method: "DELETE",
          path: "/audiences/:audience_id/contacts/:id",
          status: "hand-authored",
        },
        // Real Resend exposes GET/PATCH for a single contact, which the emulator does not implement yet.
        {
          operationId: "contacts.get",
          method: "GET",
          path: "/audiences/:audience_id/contacts/:id",
          status: "unsupported",
        },
        {
          operationId: "contacts.update",
          method: "PATCH",
          path: "/audiences/:audience_id/contacts/:id",
          status: "unsupported",
        },
      ],
    },
    { kind: "manual", title: "Resend webhook deliveries and inbox UI", coverage: "partial" },
  ],
  seedSchema: {
    description: "Seed verified sending domains and audience contacts.",
    fields: [
      {
        key: "domains",
        title: "Domains",
        description: "Pre-verified sending domains with SPF, TXT, and DKIM records.",
        example: [{ name: "example.com", region: "us-east-1" }],
      },
      {
        key: "contacts",
        title: "Contacts",
        description: "Contacts added to an audience (the Default audience when none is given).",
        example: [{ email: "test@example.com", first_name: "Test", last_name: "User" }],
      },
    ],
    example: {
      domains: [{ name: "example.com", region: "us-east-1" }],
      contacts: [{ email: "test@example.com", first_name: "Test", last_name: "User" }],
    },
  },
  stateModel: {
    description: "Entities mutated by Resend provider calls.",
    collections: [
      { name: "resend.emails" },
      { name: "resend.domains" },
      { name: "resend.api_keys" },
      { name: "resend.audiences" },
      { name: "resend.contacts" },
    ],
  },
  connections: [
    {
      id: "resend-sdk",
      title: "Resend SDK (TypeScript)",
      kind: "sdk",
      language: "typescript",
      description: "Point the Resend SDK at the emulator. The SDK reads RESEND_BASE_URL for the API base.",
      template:
        'import { Resend } from "resend";\n\n// The Resend SDK honors RESEND_BASE_URL for the API host.\nprocess.env.RESEND_BASE_URL = "{{baseUrl}}";\nconst resend = new Resend("{{token}}");\n\nawait resend.emails.send({\n  from: "onboarding@example.com",\n  to: "test@example.com",\n  subject: "Hello from the emulator",\n  html: "<p>It works.</p>",\n});',
    },
    {
      id: "resend-env",
      title: "Resend env",
      kind: "env",
      language: "bash",
      description: "The Resend SDK reads RESEND_BASE_URL and RESEND_API_KEY.",
      template: "RESEND_BASE_URL={{baseUrl}}\nRESEND_API_KEY={{token}}",
    },
    {
      id: "curl",
      title: "curl",
      kind: "curl",
      language: "bash",
      description: "Send an email directly against the REST API.",
      template:
        'curl -s -X POST {{baseUrl}}/emails \\\n  -H "authorization: Bearer {{token}}" \\\n  -H "content-type: application/json" \\\n  -d \'{"from":"onboarding@example.com","to":"test@example.com","subject":"Hello","html":"<p>Hi</p>"}\'',
    },
  ],
};
