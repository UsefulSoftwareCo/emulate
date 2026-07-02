# API Parity Harnesses

These runners record real provider and emulator responses without assertions. Compare two result files with the structural differ.

## Google

```bash
node tools/parity/run.mjs --base https://www.googleapis.com --token "$GOOGLE_TOKEN" --out google-real.json
node tools/parity/run.mjs --base http://localhost:4004 --token "$EMULATOR_TOKEN" --out google-emulator.json
node tools/parity/diff.mjs google-real.json google-emulator.json
```

## Microsoft Graph

Run against real Graph:

```bash
node tools/parity/ms-run.mjs --base https://graph.microsoft.com --token "$MS_GRAPH_TOKEN" --out ms-real.json
```

The real token should have delegated scopes for the probes you want to exercise: `User.Read`, `Files.ReadWrite.All`, `Mail.Read`, `Mail.Send`, and `Calendars.ReadWrite`. `User.Read.All` lets `/users` succeed; personal accounts often return 403, which the runner marks as `scopeLimited`.

Run against the emulator with a seed file:

```yaml
microsoft:
  users:
    - email: parity@example.com
      name: Parity User
  messages:
    - subject: Seeded parity message
      body: This message lets the mail get probe run.
      from: sender@example.com
  events:
    - subject: Seeded parity event
      start_date_time: "2026-07-03T09:00:00"
      end_date_time: "2026-07-03T09:30:00"
  drive_items:
    - name: Seeded Notes.txt
      mime_type: text/plain
      content: Notes
```

Start the emulator:

```bash
npx emulate --service microsoft --seed ms-parity.seed.yml --port 4005
```

Mint a delegated bearer token through the control plane:

```bash
curl -s -X POST http://localhost:4005/_emulate/credentials \
  -H "Content-Type: application/json" \
  -d '{"type":"bearer-token","login":"parity@example.com","scopes":["openid","email","profile","User.Read","User.Read.All","Mail.Read","Mail.Send","Calendars.ReadWrite","Files.ReadWrite.All"]}'
```

Use `credential.token` from the response:

```bash
node tools/parity/ms-run.mjs --base http://localhost:4005 --token "$EMULATOR_TOKEN" --out ms-emulator.json
node tools/parity/diff.mjs ms-real.json ms-emulator.json
```

The Microsoft runner creates probe fixtures prefixed `parity-probe-` and deletes the drive items and calendar events it creates. The `sendMail` probe sends to the signed-in user with `saveToSentItems: false`.
