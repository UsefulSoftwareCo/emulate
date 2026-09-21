---
name: context
description: Emulated Context company-lookup API (resolve a company profile from a work email address or a domain, with free and disposable mailbox domains rejected) for local development and testing. Use when the user needs company enrichment behavior without calling real Context.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Context Emulator

Stateful Context company-lookup emulation: `brand/retrieve` resolves a seeded company profile (title, description, logos, brand colors) from a work email address or a domain. Free consumer and disposable mailbox domains are rejected before any lookup, the way the real resolver rejects them, so a test cannot pass by seeding a `gmail.com` company.

## Start

```bash
npx emulate --service context
```

When all services run together, Context uses `http://localhost:4019`.

## Seed the companies the lookup can resolve

Only seeded domains resolve. Every other domain returns `404`, which is how "we do not recognize this company" is represented.

```json
{
  "context": {
    "brands": [
      {
        "domain": "acme.example",
        "title": "Acme",
        "description": "An example company.",
        "logos": [{ "url": "https://cdn.example/acme.png", "type": "icon" }],
        "colors": [{ "hex": "#101010" }]
      }
    ]
  }
}
```

Seed a running instance through the control plane:

```bash
curl -X POST http://localhost:4019/_emulate/seed \
  -H 'content-type: application/json' \
  -d '{"brands":[{"domain":"acme.example","title":"Acme"}]}'
```

## Look a company up

```bash
curl -X POST http://localhost:4019/v1/brand/retrieve \
  -H 'authorization: Bearer ctx_test_anything' \
  -H 'content-type: application/json' \
  -d '{"type":"by_email","email":"someone@acme.example"}'
```

```json
{
  "partial": false,
  "brand": {
    "domain": "acme.example",
    "title": "Acme",
    "description": "An example company.",
    "logos": [],
    "colors": []
  }
}
```

Use `{"type":"by_domain","domain":"acme.example"}` to look a domain up directly. A pasted website URL such as `https://www.acme.example/pricing` normalizes to the same domain.

## Responses to expect

| Case | Status |
| --- | --- |
| Seeded domain | `200` with `brand` |
| Domain that was never seeded | `404` |
| Free or disposable mailbox domain (`gmail.com`, `mailinator.com`, ...) | `404` |
| Malformed address or unsupported `type` | `422` |

## Test the retry path

Seed a brand with `"partial": true` to make the lookup answer `200` with `partial: true`. That models enrichment still running: the caller is expected to retry rather than cache the incomplete answer as a miss.

## Hosted use

```bash
curl -X POST https://context.emulators.dev/_emulate/instances \
  -H 'content-type: application/json' -d '{"instance":"my-run"}'
```

Mint an API key against the returned instance URL with `POST /_emulate/credentials` and `{"type":"api-key"}`, then seed and query it the same way.
