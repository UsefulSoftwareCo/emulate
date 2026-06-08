import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, base, loadInstance, randomInstance, saveInstance } from "../api";
import { serviceById } from "../services";
import { Icon } from "../App";
import InstanceBar from "../components/InstanceBar";
import SpecPanel from "../components/SpecPanel";

type LogEntry = { cls: "req" | "okc" | "errc" | "note"; text: string };

interface Flow {
  links: string[];
  run: (call: Call) => Promise<void>;
  note?: (call: Call) => Promise<void>;
  noteLabel?: string;
}

type Call = (
  method: string,
  path: string,
  opts?: { headers?: Record<string, string>; body?: string | object },
) => Promise<unknown>;

// Per-service representative flows, ported from the live emulator routes.
const FLOWS: Record<string, Flow> = {
  github: {
    links: ["/__token", "/repos/octocat/hello-world", "/graphql", "/user"],
    run: async (call) => {
      await call("POST", "/__seed", {
        body: {
          github: {
            users: [{ login: "octocat", name: "The Octocat" }],
            repos: [{ owner: "octocat", name: "hello-world", description: "demo" }],
          },
        },
      });
      const tok = ((await call("POST", "/__token", { body: { login: "octocat", scopes: ["repo"] } })) as { token?: string })?.token;
      await call("GET", "/repos/octocat/hello-world", { headers: { Authorization: `Bearer ${tok}` } });
      await call("POST", "/graphql", {
        headers: { Authorization: `Bearer ${tok}`, "user-agent": "console" },
        body: { query: '{viewer{login} repository(owner:"octocat",name:"hello-world"){nameWithOwner}}' },
      });
    },
  },
  vercel: {
    links: ["/v11/projects", "/v9/projects/acme-web/domains"],
    run: async (call) => {
      await call("POST", "/__seed", { body: { strict: false } });
      await call("POST", "/v11/projects", { headers: { Authorization: "Bearer dev" }, body: { name: "acme-web" } });
      for (const n of ["acme.com", "www.acme.com"]) {
        await call("POST", "/v10/projects/acme-web/domains", { headers: { Authorization: "Bearer dev" }, body: { name: n } });
      }
      await call("GET", "/v9/projects/acme-web/domains", { headers: { Authorization: "Bearer dev" } });
    },
  },
  google: {
    links: ["/.well-known/openid-configuration", "/discovery/v1/apis/gmail/v1/rest", "/o/oauth2/v2/auth (consent)"],
    run: async (call) => {
      await call("POST", "/__seed", {
        body: {
          google: {
            users: [{ email: "dev@example.com", name: "Dev" }],
            oauth_clients: [{ client_id: "c", client_secret: "s", redirect_uris: ["https://example.com/cb"] }],
          },
        },
      });
      await call("GET", "/.well-known/openid-configuration");
      await call("GET", "/discovery/v1/apis/gmail/v1/rest");
    },
  },
};

export default function Service() {
  const { service = "" } = useParams();
  const svc = serviceById(service);
  const flow = FLOWS[service];
  const [instance, setInstance] = useState(() => loadInstance(service));
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const b = base(service, instance);

  // Re-sync when navigating between services (the route component is reused).
  useEffect(() => {
    setInstance(loadInstance(service));
    setLog([]);
  }, [service]);

  const changeInstance = (v: string) => {
    setInstance(v);
    saveInstance(service, v);
    setLog([]);
  };

  const add = (cls: LogEntry["cls"], text: string) => setLog((l) => [{ cls, text }, ...l]);

  const call: Call = async (method, path, opts = {}) => {
    const url = `${b}${path}`;
    const hasObjBody = opts.body !== undefined && typeof opts.body !== "string";
    const bodyStr = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    add("req", `${method} ${url}${bodyStr ? `\n${bodyStr}` : ""}`);
    const headers: Record<string, string> = {
      "content-type": hasObjBody ? "application/json" : opts.headers?.["content-type"] ?? "application/x-www-form-urlencoded",
      ...opts.headers,
    };
    const r = await api(url, { method, headers, body: bodyStr });
    let pretty = r.text;
    try {
      pretty = JSON.stringify(JSON.parse(r.text), null, 2);
    } catch {
      /* keep text */
    }
    add(r.ok ? "okc" : "errc", `${r.status}\n${pretty.slice(0, 1400)}`);
    return r.json;
  };

  async function runFlow() {
    if (!flow) return;
    setBusy(true);
    add("note", `── ${svc?.name ?? service} flow ──`);
    try {
      await flow.run(call);
    } catch (e) {
      add("errc", String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!svc) {
    return (
      <>
        <h1>Unknown service</h1>
        <p className="lead">No emulator named “{service}”.</p>
      </>
    );
  }

  return (
    <>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon s={svc} size={26} /> {svc.name}
      </h1>
      <p className="lead">{svc.blurb}</p>

      <InstanceBar service={service} instance={instance} onChange={changeInstance} onRegenerate={() => changeInstance(randomInstance())} />

      <SpecPanel svc={svc} instance={instance} />

      <div className="panel">
        <div className="ph spread">
          <h2>Flow</h2>
          <button className="go" onClick={runFlow} disabled={busy || !flow}>
            {busy ? "running…" : "▶ run flow"}
          </button>
        </div>
        {flow && (
          <div className="links" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
            {flow.links.map((l) => {
              const path = l.split(" ")[0];
              return (
                <a key={l} href={`${b}${path}`} target="_blank" rel="noopener" style={{ display: "block", color: "var(--muted)", padding: "1px 0" }}>
                  {l}
                </a>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="ph spread">
          <h2>Request log</h2>
          {log.length > 0 && <button className="sm" onClick={() => setLog([])}>clear</button>}
        </div>
        {log.length === 0 && <div className="empty">Run the flow to see live requests and responses.</div>}
        {log.map((e, i) => (
          <pre key={i} className={`json ${e.cls === "req" ? "req" : e.cls === "okc" ? "okc" : e.cls === "errc" ? "errc" : "muted"}`} style={{ marginBottom: 8 }}>
            {e.text}
          </pre>
        ))}
      </div>
    </>
  );
}
