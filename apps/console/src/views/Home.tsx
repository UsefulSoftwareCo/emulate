import { useEffect, useState } from "react";
import { fetchServices, injectedServices, serviceHost } from "../api";
import type { CatalogEntry } from "../types";
import { ServiceIcon } from "../App";

export default function Home() {
  // The worker inlines the static catalog, so it's present on first paint (no
  // loading state). Fall back to fetching only when it wasn't injected (dev).
  const [services, setServices] = useState<CatalogEntry[] | null>(() => injectedServices());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (services) return;
    fetchServices()
      .then((r) => setServices(r.services))
      .catch((e) => setError(String(e)));
  }, [services]);

  return (
    <>
      <div className="hero">
        <div>
          <p className="eyebrow">Service catalog</p>
          <h1>Emulate</h1>
          <p className="lead">
            Stateful integration emulators for real developer APIs. Pick a service, create an isolated instance, copy a
            ready-to-run connection snippet, then inspect credentials, state, requests, specs, and webhooks under{" "}
            <code>/_emulate</code>.
          </p>
        </div>
        <div className="hero-actions">
          <a className="button" href="/_emulate/services" target="_blank" rel="noopener">
            Services API
          </a>
        </div>
      </div>
      <p className="lead">
        Service hosts use <code>service.emulators.dev</code>. Instance hosts use{" "}
        <code>service.instance.emulators.dev</code>.
      </p>

      {error && <div className="empty">Could not load the service catalog ({error}).</div>}

      {services && services.length > 0 && (
        <p className="eyebrow">All emulators · {services.length}</p>
      )}

      <div className="service-grid">
        {(services ?? []).map((s) => (
          <a key={s.id} href={serviceHost(s.id)} className="card service-card-simple">
            <div className="hd">
              <ServiceIcon src={s.icon} name={s.name} />
              <span className="service-title">{s.name}</span>
            </div>
            <p className="b">{s.description}</p>
            <div className="kv" style={{ marginTop: 10 }}>
              <b>host</b> {s.serviceHost}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
