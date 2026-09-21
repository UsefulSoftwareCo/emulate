---
name: context
description: Use the Context.dev emulator to test company lookup by email domain through a running HTTP service.
---

# Context.dev company lookup

Create an instance with `POST https://context.emulators.dev/_emulate/instances`.
Save its returned provider base URL privately. Create an `api-key` credential
at `/_emulate/credentials` and seed `{"brands":[{"domain":"company.example","title":"Example Company"}]}`
at `/_emulate/seed`. Call `POST /v1/brand/retrieve` with bearer auth and
`{"type":"by_email","email":"person@company.example"}`.

Unknown domains return 404. Only company names are populated; logos/colors are
empty. Use the shared ledger and fault endpoints for inspection and failures.
For local use, run `npx emulate --service context`.
