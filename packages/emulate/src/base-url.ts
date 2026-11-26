export interface ResolveBaseUrlOptions {
  service: string;
  port: number;
  /** Address the server listens on; names the default URL when given. */
  hostname?: string;
  baseUrl?: string;
  seedBaseUrl?: string;
}

/**
 * Fallback chain:
 * 1. Per-service baseUrl from seed config
 * 2. Explicit baseUrl (CLI flag or programmatic option)
 * 3. EMULATE_BASE_URL env var (with {service} interpolation)
 * 4. PORTLESS_URL env var (with {service} interpolation)
 * 5. http://<hostname>:<port> when a listen address was given, else http://localhost:<port>
 */
export function resolveBaseUrl(opts: ResolveBaseUrlOptions): string {
  if (opts.seedBaseUrl) {
    return opts.seedBaseUrl.replace(/\{service\}/g, opts.service);
  }
  if (opts.baseUrl) {
    return opts.baseUrl.replace(/\{service\}/g, opts.service);
  }
  const envBaseUrl = process.env.EMULATE_BASE_URL;
  if (envBaseUrl) {
    return envBaseUrl.replace(/\{service\}/g, opts.service);
  }
  const portlessUrl = process.env.PORTLESS_URL;
  if (portlessUrl) {
    return portlessUrl.replace(/\{service\}/g, opts.service);
  }
  if (opts.hostname && !isAnyAddress(opts.hostname)) {
    const host = opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname;
    return `http://${host}:${opts.port}`;
  }
  return `http://localhost:${opts.port}`;
}

function isAnyAddress(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
}
