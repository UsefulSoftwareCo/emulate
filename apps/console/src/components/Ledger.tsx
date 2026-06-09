import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchLedger } from "../api";
import type { LedgerEntry } from "../types";

// The request ledger inspector. This is the core promised surface: it shows how
// ANY client (SDK, CLI, app) called the emulator, not just calls the console made.
export default function Ledger({ service, instance }: { service: string; instance: string }) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const reload = useCallback(() => {
    fetchLedger(service, instance, 100)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(String(e)));
  }, [service, instance]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [auto, reload]);

  return (
    <div className="panel">
      <div className="ph spread">
        <h2>Request ledger</h2>
        <div className="row">
          <label className="muted" style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              style={{ width: "auto" }}
            />
            auto
          </label>
          <button className="sm" onClick={reload}>
            refresh
          </button>
        </div>
      </div>
      {error && <div className="empty">{error}</div>}
      {entries && entries.length === 0 && (
        <div className="empty">
          No requests yet. Point an SDK, CLI, or app at the provider URL and they appear here.
        </div>
      )}
      {entries && entries.length > 0 && (
        <table className="data-table ledger-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Route</th>
              <th>Status</th>
              <th>Identity</th>
              <th>Effects</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const identity = e.identity?.user?.login ?? e.identity?.app?.name ?? "-";
              const fx = (e.sideEffects?.length ?? 0) + (e.webhookDeliveries?.length ?? 0);
              const isOpen = open === e.id;
              return (
                <Fragment key={e.id}>
                  <tr className="ledger-row" onClick={() => setOpen(isOpen ? null : e.id)}>
                    <td className="mono">{e.method}</td>
                    <td className="mono">{e.route ?? e.path}</td>
                    <td>
                      <span className={`tag ${e.response.status < 400 ? "ok" : "err"}`}>{e.response.status}</span>
                    </td>
                    <td className="muted">{identity}</td>
                    <td>{fx > 0 ? fx : ""}</td>
                    <td className="muted">{e.durationMs}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6}>
                        <pre className="json">{JSON.stringify(e, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
