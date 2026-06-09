import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  controlBase,
  fetchCoverage,
  fetchManifest,
  fetchState,
  loadInstance,
  postControl,
  saveInstance,
} from "../api";
import type { CoverageReport, ManifestResponse, ResolvedConnection } from "../types";
import { ServiceIcon } from "../App";
import InstanceBar from "../components/InstanceBar";
import Ledger from "../components/Ledger";

const copy = (t: string) => navigator.clipboard?.writeText(t);

export default function Service({
  serviceOverride,
  instanceOverride,
}: {
  serviceOverride?: string;
  instanceOverride?: string;
} = {}) {
  const params = useParams();
  const service = serviceOverride ?? params.service ?? "";
  const pinned = Boolean(instanceOverride);
  const [instance, setInstance] = useState(() => instanceOverride ?? loadInstance(service));
  const [data, setData] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");

  const load = useCallback(() => {
    setData(null);
    setError(null);
    fetchManifest(service, instance)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [service, instance]);

  useEffect(() => {
    setInstance(instanceOverride ?? loadInstance(service));
  }, [service, instanceOverride]);

  useEffect(() => {
    load();
  }, [load]);

  const changeInstance = (v: string) => {
    setInstance(v);
    if (!pinned) saveInstance(service, v);
  };

  const manifest = data?.manifest;
  const tabs = manifest?.inspectorTabs ?? [{ id: "overview", title: "Overview", kind: "landing" as const }];

  if (error) {
    return (
      <>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ServiceIcon src={`/_emulate/icons/${service}`} name={service} /> {service}
        </h1>
        <div className="empty">Could not load this emulator ({error}). The instance is created on first use.</div>
        <InstanceBar service={service} instance={instance} pinned={pinned} onChange={changeInstance} />
      </>
    );
  }

  if (!manifest) {
    return (
      <>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ServiceIcon src={`/_emulate/icons/${service}`} name={service} /> {service}
        </h1>
        <div className="empty">Loading manifest...</div>
      </>
    );
  }

  return (
    <>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ServiceIcon src={`/_emulate/icons/${service}`} name={manifest.name} /> {manifest.name}
      </h1>
      <p className="lead">{manifest.description}</p>

      <InstanceBar service={service} instance={instance} pinned={pinned} onChange={changeInstance} />

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.title}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview data={data!} />}
      {tab === "ledger" && <Ledger service={service} instance={instance} />}
      {tab === "state" && <StateTab service={service} instance={instance} />}
      {tab === "credentials" && <CredentialsTab manifest={manifest} service={service} instance={instance} />}
      {tab === "seed" && <SeedTab manifest={manifest} service={service} instance={instance} onSeeded={load} />}
      {tab === "spec" && <SpecTab service={service} instance={instance} />}
      {tab === "logs" && <LogsTab service={service} instance={instance} />}
    </>
  );
}

function Overview({ data }: { data: ManifestResponse }) {
  const { manifest, instance, connections } = data;
  return (
    <>
      <div className="panel">
        <div className="ph">
          <h2>Surfaces</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Status</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {manifest.surfaces.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>
                  <span className={`tag ${s.status === "supported" ? "ok" : ""}`}>{s.status}</span>
                </td>
                <td className="mono">{s.basePath ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="ph">
          <h2>Auth capabilities</h2>
        </div>
        <table className="data-table">
          <tbody>
            {manifest.auth.map((a) => (
              <tr key={a.id}>
                <td>{a.title}</td>
                <td className="mono muted">{a.type}</td>
                <td>
                  <span className={`tag ${a.status === "supported" ? "ok" : ""}`}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Connections connections={connections} instance={instance} />
    </>
  );
}

function Connections({
  connections,
  instance,
}: {
  connections: ResolvedConnection[];
  instance: ManifestResponse["instance"];
}) {
  if (!connections.length) return null;
  return (
    <div className="panel">
      <div className="ph">
        <h2>Connect</h2>
      </div>
      {instance && (
        <div className="kv" style={{ marginBottom: 12 }}>
          <b>provider</b> {instance.providerBaseUrl}
        </div>
      )}
      {connections.map((c) => (
        <div key={c.id} style={{ marginBottom: 14 }}>
          <div className="row spread">
            <span className="muted" style={{ fontSize: 13 }}>
              {c.title}
              {c.language ? ` · ${c.language}` : ""}
            </span>
            <button className="sm copy" onClick={() => copy(c.body)}>
              copy
            </button>
          </div>
          {c.description && (
            <p className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>
              {c.description}
            </p>
          )}
          <pre className="json">{c.body}</pre>
        </div>
      ))}
    </div>
  );
}

function StateTab({ service, instance }: { service: string; instance: string }) {
  const [state, setState] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fetchState(service, instance)
      .then(setState)
      .catch((e) => setError(String(e)));
  }, [service, instance]);
  useEffect(() => {
    reload();
  }, [reload]);
  return (
    <div className="panel">
      <div className="ph spread">
        <h2>State</h2>
        <button className="sm" onClick={reload}>
          refresh
        </button>
      </div>
      {error && <div className="empty">{error}</div>}
      <pre className="json">{state ? JSON.stringify(state, null, 2) : "..."}</pre>
    </div>
  );
}

function CredentialsTab({
  manifest,
  service,
  instance,
}: {
  manifest: ManifestResponse["manifest"];
  service: string;
  instance: string;
}) {
  const types = useMemo(() => Array.from(new Set(manifest.auth.map((a) => a.type))), [manifest]);
  const [type, setType] = useState(types[0] ?? "bearer-token");
  const [login, setLogin] = useState("admin");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    setBusy(true);
    setResult(null);
    const body: Record<string, unknown> = { type };
    if (type === "bearer-token" || type === "api-key") body.login = login;
    const r = await postControl(service, instance, "/credentials", body);
    setResult(JSON.stringify(r.json, null, 2));
    setBusy(false);
  };

  return (
    <div className="panel">
      <div className="ph">
        <h2>Create a credential</h2>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {(type === "bearer-token" || type === "api-key") && (
          <input className="mono" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="login" />
        )}
        <button className="go" onClick={mint} disabled={busy}>
          {busy ? "..." : "mint"}
        </button>
      </div>
      {result && (
        <>
          <div className="row spread">
            <span className="muted" style={{ fontSize: 12 }}>
              result
            </span>
            <button className="sm copy" onClick={() => copy(result)}>
              copy
            </button>
          </div>
          <pre className="json okc">{result}</pre>
        </>
      )}
    </div>
  );
}

function SeedTab({
  manifest,
  service,
  instance,
  onSeeded,
}: {
  manifest: ManifestResponse["manifest"];
  service: string;
  instance: string;
  onSeeded: () => void;
}) {
  const example = manifest.seedSchema?.example;
  const [body, setBody] = useState(() => (example ? JSON.stringify(example, null, 2) : "{}"));
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (path: "/seed" | "/reset") => {
    setBusy(true);
    setResult(null);
    let payload: unknown = undefined;
    if (path === "/seed") {
      try {
        payload = JSON.parse(body);
      } catch (e) {
        setResult(`Invalid JSON: ${String(e)}`);
        setBusy(false);
        return;
      }
    }
    const r = await postControl(service, instance, path, payload);
    setResult(`${r.status}\n${r.text}`);
    setBusy(false);
    onSeeded();
  };

  return (
    <div className="panel">
      <div className="ph spread">
        <h2>Seed state</h2>
        <button className="sm" onClick={() => run("/reset")} disabled={busy}>
          reset instance
        </button>
      </div>
      {manifest.seedSchema?.description && (
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {manifest.seedSchema.description}
        </p>
      )}
      <textarea
        className="mono"
        style={{ width: "100%", minHeight: 220, resize: "vertical" }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="go" onClick={() => run("/seed")} disabled={busy}>
          {busy ? "..." : "seed"}
        </button>
      </div>
      {result && <pre className="json">{result}</pre>}
    </div>
  );
}

function SpecTab({ service, instance }: { service: string; instance: string }) {
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchCoverage(service, instance)
      .then(setCoverage)
      .catch((e) => setError(String(e)));
  }, [service, instance]);

  if (error) return <div className="empty">{error}</div>;
  if (!coverage) return <div className="empty">Loading coverage...</div>;

  return (
    <>
      <div className="panel">
        <div className="ph">
          <h2>Spec coverage</h2>
        </div>
        <div className="row" style={{ gap: 14, marginBottom: 12 }}>
          {Object.entries(coverage.summary).map(([k, v]) => (
            <span key={k} className="tag">
              {k}: {v}
            </span>
          ))}
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Spec</th>
              <th>Kind</th>
              <th>Coverage</th>
              <th>Operations</th>
            </tr>
          </thead>
          <tbody>
            {coverage.specs.map((s, i) => (
              <tr key={i}>
                <td>{s.title}</td>
                <td className="mono muted">{s.kind}</td>
                <td>
                  <span className="tag">{s.coverage}</span>
                </td>
                <td>{s.operationCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {coverage.operations.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h2>Operations</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {coverage.operations.map((o, i) => (
                <tr key={i}>
                  <td className="mono">{o.operationId}</td>
                  <td className="mono muted">{o.method ?? ""}</td>
                  <td className="mono muted">{o.path ?? ""}</td>
                  <td>
                    <span className={`tag ${o.status === "hand-authored" ? "ok" : ""}`}>{o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function LogsTab({ service, instance }: { service: string; instance: string }) {
  const [logs, setLogs] = useState<{ webhooks: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api(`${controlBase(service, instance)}/logs`)
      .then((r) => setLogs(r.json as { webhooks: unknown[] }))
      .catch((e) => setError(String(e)));
  }, [service, instance]);
  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="panel">
      <div className="ph spread">
        <h2>Webhook deliveries</h2>
        <button className="sm" onClick={reload}>
          refresh
        </button>
      </div>
      {error && <div className="empty">{error}</div>}
      {logs && (logs.webhooks?.length ?? 0) === 0 && <div className="empty">No webhook deliveries yet.</div>}
      {logs && (logs.webhooks?.length ?? 0) > 0 && <pre className="json">{JSON.stringify(logs.webhooks, null, 2)}</pre>}
    </div>
  );
}
