import type { Store } from "@emulators/core";

// WHERE an MCP server advertises the OAuth scopes a client must request. A
// spec-faithful client discovers scopes from the server's metadata at connect
// (it declares none itself), so the source decides which document it has to read
// and exercises a distinct branch of that discovery:
//  - "resource":             RFC 9728 protected-resource metadata carries
//                            `scopes_supported`; the authorization-server
//                            metadata omits it. The resource list is authoritative.
//  - "authorization-server": the protected-resource metadata stays SILENT on
//                            scopes, so the client must fall back to the RFC 8414
//                            authorization-server metadata it names. The
//                            real-world case that motivated scope discovery.
//  - "both":                 both documents advertise the scopes (the default;
//                            matches the historical emulator behavior).
//  - "none":                 neither document advertises scopes, so a discovering
//                            client requests none.
export type McpScopeSource = "resource" | "authorization-server" | "both" | "none";

export interface McpScopeConfig {
  // The scopes the MCP server requires. Advertised in the document(s) named by
  // `source`. An empty array is meaningful: advertised at `source`, it tells a
  // client the resource needs NO scopes (RFC 9728 §2 defines an empty
  // `scopes_supported`), which is distinct from a silent document.
  scopes: string[];
  source: McpScopeSource;
}

const DATA_KEY = "mcp.scopeConfig";

// The historical default: GitHub-style scopes advertised in both the
// protected-resource and authorization-server metadata. Preserves the behavior
// of instances that never configure scopes.
const DEFAULT_SCOPES = ["repo", "read:user"];
const DEFAULT_SOURCE: McpScopeSource = "both";

export function setMcpScopeConfig(store: Store, raw: unknown): void {
  const cfg = (raw ?? {}) as { scopes?: unknown; source?: unknown; scopeSource?: unknown };
  const scopes = Array.isArray(cfg.scopes)
    ? cfg.scopes.filter((s): s is string => typeof s === "string")
    : DEFAULT_SCOPES;
  // Accept `source` (the stored field) or `scopeSource` (the seed field name).
  const rawSource = typeof cfg.source === "string" ? cfg.source : cfg.scopeSource;
  const source: McpScopeSource =
    rawSource === "resource" || rawSource === "authorization-server" || rawSource === "none"
      ? rawSource
      : DEFAULT_SOURCE;
  store.setData<McpScopeConfig>(DATA_KEY, { scopes, source });
}

export function getMcpScopeConfig(store: Store): McpScopeConfig {
  return store.getData<McpScopeConfig>(DATA_KEY) ?? { scopes: [...DEFAULT_SCOPES], source: DEFAULT_SOURCE };
}

// The `scopes_supported` value to publish in the RFC 9728 protected-resource
// metadata, or `undefined` to OMIT the field entirely (a silent document, which
// forces a discovering client to the authorization-server fallback). `undefined`
// vs `[]` is a real distinction: `[]` is an authoritative "no scopes here".
export function resourceScopesSupported(cfg: McpScopeConfig): string[] | undefined {
  return cfg.source === "resource" || cfg.source === "both" ? cfg.scopes : undefined;
}

// The `scopes_supported` value to publish in the RFC 8414 authorization-server
// metadata, or `undefined` to omit it.
export function authServerScopesSupported(cfg: McpScopeConfig): string[] | undefined {
  return cfg.source === "authorization-server" || cfg.source === "both" ? cfg.scopes : undefined;
}
