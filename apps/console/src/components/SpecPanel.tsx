import { base, ORIGIN } from "../api";
import type { Svc } from "../services";

const copy = (t: string) => navigator.clipboard?.writeText(t);

// MCP doesn't use instance ids — it has friendly connection-type routes that pick
// the auth mode by URL (and need no seeding).
function McpRoutes() {
  const routes = [
    { url: `${ORIGIN}/github/oauth/mcp`, label: "OAuth (DCR)", note: "zero-config — full MCP-OAuth handshake" },
    { url: `${ORIGIN}/github/bearer/mcp`, label: "Bearer", note: "Authorization: Bearer demo-token" },
    { url: `${ORIGIN}/github/query/mcp`, label: "Query param", note: "?token=demo-token" },
  ];
  return (
    <div className="panel">
      <div className="ph spread">
        <h2>Add to Executor</h2>
        <span className="tag">MCP server</span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Add as an MCP source — point Executor at the route for the connection type you want to test. No instance id, no
        seeding.
      </p>
      {routes.map((r) => (
        <div key={r.url} className="app">
          <div className="row spread">
            <b>{r.label}</b>
            <button className="sm copy" onClick={() => copy(r.url)}>copy</button>
          </div>
          <div className="cred">
            <a href={r.url} target="_blank" rel="noopener">{r.url}</a>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{r.note}</div>
        </div>
      ))}
    </div>
  );
}

// "Add to Executor" — surfaces the spec URL this emulator instance serves, so it
// can be added as an Executor source by pasting the URL (or via the API payload).
export default function SpecPanel({ svc, instance }: { svc: Svc; instance: string }) {
  if (!svc.spec) return null;
  if (svc.spec.kind === "mcp") return <McpRoutes />;
  const b = base(svc.id, instance);
  const url = `${b}${svc.spec.path}`;

  const kindLabel = svc.spec.kind === "googleDiscovery" ? "Google Discovery (kind: googleDiscovery)" : "OpenAPI (kind: url)";

  // The shape Executor's POST /api/scopes/:id/openapi/specs accepts.
  const payload = JSON.stringify(
    { spec: { kind: svc.spec.kind, url }, baseUrl: b, name: `${svc.name} (Emulated)`, namespace: `${svc.id}-emu` },
    null,
    2,
  );

  return (
    <div className="panel">
      <div className="ph spread">
        <h2>Add to Executor</h2>
        <span className="tag">{kindLabel}</span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Add as an OpenAPI source — paste this spec URL into Executor (Sources → Add). Auth: {svc.spec.authNote}.
      </p>
      <div className="kv" style={{ marginBottom: 8 }}>
        <b>spec url</b>{" "}
        <a href={url} target="_blank" rel="noopener">{url}</a>{" "}
        <button className="sm copy" onClick={() => copy(url)}>copy</button>
      </div>
      <div className="row spread">
        <span className="muted" style={{ fontSize: 12.5 }}>API request body</span>
        <button className="sm copy" onClick={() => copy(payload)}>copy payload</button>
      </div>
      <pre className="json" style={{ marginTop: 6 }}>{payload}</pre>
    </div>
  );
}
