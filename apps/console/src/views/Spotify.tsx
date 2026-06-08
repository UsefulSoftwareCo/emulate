import { useCallback, useEffect, useState } from "react";
import { api, base, loadInstance, randomInstance, saveInstance } from "../api";
import InstanceBar from "../components/InstanceBar";
import SpecPanel from "../components/SpecPanel";
import { serviceById } from "../services";

interface App {
  client_id: string;
  client_secret: string;
  name: string;
}
interface SearchResults {
  artists?: { items: Array<{ id: string; name: string; genres?: string[]; followers?: { total: number } }> };
  albums?: { items: Array<{ id: string; name: string; release_date?: string }> };
  tracks?: { items: Array<{ id: string; name: string; duration_ms?: number }> };
}

export default function Spotify() {
  const [instance, setInstance] = useState(() => loadInstance("spotify"));
  const [apps, setApps] = useState<App[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [q, setQ] = useState("daft punk");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [note, setNote] = useState("");
  const b = base("spotify", instance);

  const loadApps = useCallback(async () => {
    const r = await api(`${b}/_emulator/apps`);
    setApps(((r.json as { apps?: App[] })?.apps ?? []) as App[]);
  }, [b]);
  useEffect(() => {
    setResults(null);
    setTokens({});
    setActive(null);
    void loadApps();
  }, [loadApps]);

  const changeInstance = (v: string) => {
    setInstance(v);
    saveInstance("spotify", v);
  };

  async function createApp() {
    await api(`${b}/_emulator/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `App ${apps.length + 1}` }),
    });
    await loadApps();
    setNote("Created a new app — copy its client_id/secret or get a token.");
  }

  async function getToken(app: App) {
    const basic = btoa(`${app.client_id}:${app.client_secret}`);
    const r = await api(`${b}/api/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const tok = (r.json as { access_token?: string })?.access_token;
    if (tok) {
      setTokens((t) => ({ ...t, [app.client_id]: tok }));
      setActive(app.client_id);
      setNote(`Got an app token for “${app.name}” via client_credentials. It's now the active token.`);
    } else {
      setNote(`Token request failed: ${r.text.slice(0, 120)}`);
    }
  }

  async function search() {
    const tok = active ? tokens[active] : null;
    if (!tok) {
      setNote("Get a token for one of the apps first (Client Credentials).");
      return;
    }
    const r = await api(`${b}/v1/search?q=${encodeURIComponent(q)}&type=artist,album,track`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    setResults(r.json as SearchResults);
  }

  const copy = (t: string) => navigator.clipboard?.writeText(t);

  return (
    <>
      <h1>Spotify</h1>
      <p className="lead">
        OAuth 2.0 <b>Client Credentials</b> — there's no user. Create one or more “apps” (each gets a
        client_id/secret), exchange them for app tokens, then browse the catalog. Make as many as you like to
        simulate multiple integrations.
      </p>

      <InstanceBar service="spotify" instance={instance} onChange={changeInstance} onRegenerate={() => changeInstance(randomInstance())} />

      <SpecPanel svc={serviceById("spotify")!} instance={instance} />

      <div className="panel">
        <div className="ph spread">
          <h2>Apps &amp; credentials</h2>
          <button className="go" onClick={createApp}>＋ create app</button>
        </div>
        {apps.length === 0 && <div className="empty">No apps yet — create one.</div>}
        {apps.map((app) => (
          <div key={app.client_id} className={`app${active === app.client_id ? " active" : ""}`}>
            <div className="row spread">
              <b>{app.name}</b>
              {active === app.client_id ? <span className="tag ok">active token</span> : <span className="tag">no token</span>}
            </div>
            <div className="cred">
              <b>client_id</b> {app.client_id} <button className="sm copy" onClick={() => copy(app.client_id)}>copy</button>
            </div>
            <div className="cred">
              <b>client_secret</b> {app.client_secret} <button className="sm copy" onClick={() => copy(app.client_secret)}>copy</button>
            </div>
            {tokens[app.client_id] && (
              <div className="cred">
                <b>token</b> {tokens[app.client_id].slice(0, 28)}… <button className="sm copy" onClick={() => copy(tokens[app.client_id])}>copy</button>
              </div>
            )}
            <div className="row" style={{ marginTop: 9 }}>
              <button className="sm go" onClick={() => getToken(app)}>get token</button>
              {tokens[app.client_id] && active !== app.client_id && (
                <button className="sm" onClick={() => setActive(app.client_id)}>use this token</button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="ph"><h2>Catalog</h2></div>
        <div className="row">
          <input className="mono" style={{ flex: 1, minWidth: 220 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="search artists / albums / tracks…" onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className="go" onClick={search}>search</button>
        </div>
        {note && <p className="muted" style={{ fontSize: 13 }}>{note}</p>}
        {results && (
          <>
            {(["artists", "albums", "tracks"] as const).map((kind) => {
              const items = results[kind]?.items ?? [];
              if (!items.length) return null;
              return (
                <div key={kind}>
                  <h2 style={{ textTransform: "capitalize" }}>{kind}</h2>
                  <div className="results">
                    {items.map((it) => (
                      <div className="res" key={it.id}>
                        <div className="n">{it.name}</div>
                        <div className="s">
                          {kind === "artists" && ((it as { genres?: string[] }).genres?.join(", ") || "artist")}
                          {kind === "albums" && ((it as { release_date?: string }).release_date || "album")}
                          {kind === "tracks" && `${Math.round(((it as { duration_ms?: number }).duration_ms ?? 0) / 1000)}s`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
