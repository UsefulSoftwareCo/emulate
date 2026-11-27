---
name: zapier
description: Emulated Zapier MCP server (managed mode) for testing MCP clients and gateways. Use when the user needs a remote MCP server with OAuth per person, a different tool list per account, thousands of tools, tool lists that change without notice, or both MCP protocol eras (2026-07-28 and 2025-11-25 / 2025-06-18), without calling real Zapier.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Zapier MCP Emulator

Zapier's remote MCP server in managed mode at `<base>/api/v1/connect`, with OAuth discovery as `mcp.zapier.com` publishes it.

## Start

```bash
npx emulate --service zapier
```

When all services run together, Zapier uses `http://localhost:4023`.

## Connect

Point an MCP client at `<base>/api/v1/connect`; it discovers OAuth from the `401`. Or use a connection token:

```bash
curl -X POST "$ZAPIER_EMULATOR_URL/_emulate/zapier/accounts" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","tools":{"count":3000}}'
curl -X POST "$ZAPIER_EMULATOR_URL/_emulate/zapier/accounts/ada%40example.com/connection-token"
```

## Change a list

```bash
# Silent by default, as Zapier announces no changes
curl -X POST "$ZAPIER_EMULATOR_URL/_emulate/zapier/accounts/ada%40example.com/tools" -H "Content-Type: application/json" \
  -d '{"add":5,"remove":{"count":2},"rename":{"old_name":"new_name"}}'

# Emulator controls, not Zapier behaviour: announce changes, limit an account
curl -X POST "$ZAPIER_EMULATOR_URL/_emulate/zapier/settings" -H "Content-Type: application/json" \
  -d '{"list_changed":true,"rate_limit":{"requests":60,"window_seconds":60}}'
```

## Tool behaviours

```bash
curl -X POST "$ZAPIER_EMULATOR_URL/_emulate/zapier/accounts/ada%40example.com/behaviors" -H "Content-Type: application/json" \
  -d '{"tool":"<name>","delay_ms":2000}'   # or "fail":"tool" | "protocol", or "result_bytes":1048576
```

## Discovery

`GET /_emulate/manifest` lists what is supported and what is not (agentic-mode meta-tools, resources, prompts, sampling, elicitation and SSE are not emulated). `GET /_emulate/ledger` records each request with the account, the JSON-RPC method and, for calls, the tool; list changes appear as `zapier.control.tools.change` entries. `GET /_emulate/zapier/usage` counts lists and calls per account and tool. Per-service docs live at `https://docs.emulators.dev/zapier`.
