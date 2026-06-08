import { useCallback, useEffect, useState } from "react";
import { api, base, loadInstance, loadJson, randomInstance, saveInstance, saveJson } from "../api";
import InstanceBar from "../components/InstanceBar";
import SpecPanel from "../components/SpecPanel";
import { serviceById } from "../services";

// Unlike Spotify (client-credentials), Vercel uses user-scoped bearer tokens.
// An "account" = a seeded user + its bootstrap token (minted via /__token); each
// account can then mint named personal API keys (the real POST /v1/api-keys).
interface Account {
  login: string;
  token: string;
}
interface ApiKey {
  id: string;
  name: string;
  secret?: string; // apiKeyString — only returned at creation, kept client-side
}
interface Domain {
  name: string;
  apexName?: string;
  verified?: boolean;
  createdAt?: number;
}

export default function Vercel() {
  const [instance, setInstance] = useState(() => loadInstance("vercel"));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [keys, setKeys] = useState<Record<string, ApiKey[]>>({});
  const [active, setActive] = useState<string | null>(null);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const b = base("vercel", instance);
  const acctKey = `emu.vercel.accounts.${instance}`;
  const keysKey = `emu.vercel.keys.${instance}`;

  const persist = (accts: Account[], ks: Record<string, ApiKey[]>) => {
    saveJson(acctKey, accts);
    saveJson(keysKey, ks);
  };

  const loadKeys = useCallback(
    async (acct: Account, stored: Record<string, ApiKey[]>) => {
      const r = await api(`${b}/v1/api-keys`, { headers: { authorization: `Bearer ${acct.token}` } });
      const server = ((r.json as { keys?: ApiKey[] })?.keys ?? []) as ApiKey[];
      // Reconcile: server is the source of truth for id/name; keep our secrets.
      const prev = stored[acct.login] ?? [];
      const merged = server.map((k) => ({ ...k, secret: prev.find((p) => p.id === k.id)?.secret }));
      setKeys((m) => ({ ...m, [acct.login]: merged }));
    },
    [b],
  );

  useEffect(() => {
    const accts = loadJson<Account[]>(acctKey, []);
    const ks = loadJson<Record<string, ApiKey[]>>(keysKey, {});
    setAccounts(accts);
    setKeys(ks);
    setActive(accts[0]?.login ?? null);
    setDomains(null);
    setNote("");
    for (const a of accts) void loadKeys(a, ks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  const changeInstance = (v: string) => {
    setInstance(v);
    saveInstance("vercel", v);
  };

  async function addAccount() {
    if (busy) return;
    setBusy(true);
    try {
      const used = new Set(accounts.map((a) => a.login));
      let n = accounts.length + 1;
      while (used.has(`acct-${n}`)) n++;
      const login = `acct-${n}`;
      const r = await api(`${b}/__token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, scopes: ["user"] }),
      });
      const token = (r.json as { token?: string })?.token;
      if (!token) {
        setNote(`Mint failed: ${r.text.slice(0, 120)}`);
        return;
      }
      const next = [...accounts, { login, token }];
      setAccounts(next);
      setActive(login);
      persist(next, keys);
      setNote(`Created account “${login}” with a bootstrap token. Mint API keys below, or use it directly as a Bearer.`);
    } finally {
      setBusy(false);
    }
  }

  async function createKey(acct: Account) {
    const name = `Key ${(keys[acct.login]?.length ?? 0) + 1}`;
    const r = await api(`${b}/v1/api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${acct.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = r.json as { apiKeyString?: string; apiKey?: { id: string; name: string } };
    if (!body.apiKeyString || !body.apiKey) {
      setNote(`Create key failed: ${r.text.slice(0, 120)}`);
      return;
    }
    const key: ApiKey = { id: body.apiKey.id, name: body.apiKey.name, secret: body.apiKeyString };
    const next = { ...keys, [acct.login]: [...(keys[acct.login] ?? []), key] };
    setKeys(next);
    persist(accounts, next);
    setNote(`Minted API key “${name}” for ${acct.login}. The token is shown once — copy it now.`);
  }

  async function runDomainsFlow() {
    const acct = accounts.find((a) => a.login === active);
    if (!acct) {
      setNote("Add an account first (it mints the bootstrap token the flow uses).");
      return;
    }
    const auth = { authorization: `Bearer ${acct.token}`, "content-type": "application/json" };
    await api(`${b}/v11/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: "acme-web" }) });
    for (const n of ["acme.com", "www.acme.com"]) {
      await api(`${b}/v10/projects/acme-web/domains`, { method: "POST", headers: auth, body: JSON.stringify({ name: n }) });
    }
    const r = await api(`${b}/v9/projects/acme-web/domains`, { headers: { authorization: `Bearer ${acct.token}` } });
    setDomains(((r.json as { domains?: Domain[] })?.domains ?? []) as Domain[]);
    setNote(`Listed domains for project “acme-web” as ${acct.login}.`);
  }

  const copy = (t: string) => navigator.clipboard?.writeText(t);

  return (
    <>
      <h1>Vercel</h1>
      <p className="lead">
        User-scoped bearer auth — each <b>account</b> gets a bootstrap token (minted via the control plane), and from
        it you mint named <b>API keys</b> (the real <code>POST /v1/api-keys</code>). Add several to simulate many
        accounts. Use any token as a <code>Bearer</code> against the REST API.
      </p>

      <InstanceBar service="vercel" instance={instance} onChange={changeInstance} onRegenerate={() => changeInstance(randomInstance())} />

      <SpecPanel svc={serviceById("vercel")!} instance={instance} />

      <div className="panel">
        <div className="ph spread">
          <h2>Accounts &amp; API keys</h2>
          <button className="go" onClick={addAccount} disabled={busy}>＋ add account</button>
        </div>
        {accounts.length === 0 && <div className="empty">No accounts yet — add one to mint a token.</div>}
        {accounts.map((acct) => (
          <div key={acct.login} className={`app${active === acct.login ? " active" : ""}`}>
            <div className="row spread">
              <b>{acct.login}</b>
              {active === acct.login ? <span className="tag ok">active</span> : (
                <button className="sm" onClick={() => setActive(acct.login)}>use this account</button>
              )}
            </div>
            <div className="cred">
              <b>token</b> {acct.token.slice(0, 30)}… <button className="sm copy" onClick={() => copy(acct.token)}>copy</button>
            </div>
            <div className="row spread" style={{ marginTop: 9 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>API keys</span>
              <button className="sm go" onClick={() => createKey(acct)}>＋ create API key</button>
            </div>
            {(keys[acct.login] ?? []).length === 0 && <div className="empty" style={{ fontSize: 12.5 }}>No API keys yet.</div>}
            {(keys[acct.login] ?? []).map((k) => (
              <div key={k.id} className="cred">
                <b>{k.name}</b>{" "}
                {k.secret ? (
                  <>
                    {k.secret.slice(0, 24)}… <button className="sm copy" onClick={() => copy(k.secret!)}>copy</button>
                  </>
                ) : (
                  <span className="muted">{k.id} (token shown only at creation)</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="ph spread">
          <h2>Projects &amp; domains</h2>
          <button className="go" onClick={runDomainsFlow}>▶ create project + list domains</button>
        </div>
        {note && <p className="muted" style={{ fontSize: 13 }}>{note}</p>}
        {domains && (
          <>
            <h2>Domains on acme-web</h2>
            <div className="results">
              {domains.map((d) => (
                <div className="res" key={d.name}>
                  <div className="n">{d.name}</div>
                  <div className="s">{d.apexName && d.apexName !== d.name ? `apex ${d.apexName}` : "apex"}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
