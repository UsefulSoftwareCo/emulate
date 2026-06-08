export interface Svc {
  id: string;
  name: string;
  icon: string; // CDN url or emoji
  blurb: string;
  auth: string;
  accent: string;
  // What to hand Executor to add this emulator as a source. `path` is appended to
  // the instance base URL; `kind` is the Executor spec kind; `authNote` describes
  // how auth is wired when you add it.
  spec?: { kind: "url" | "googleDiscovery" | "mcp"; path: string; authNote: string };
}

export const SERVICES: Svc[] = [
  {
    id: "spotify",
    name: "Spotify",
    icon: "https://cdn.simpleicons.org/spotify",
    blurb: "OAuth 2.0 Client Credentials — mint app tokens (no user) and browse the catalog.",
    auth: "Client Credentials",
    accent: "#1DB954",
    spec: { kind: "url", path: "/openapi.json", authNote: "OAuth2 · Client Credentials" },
  },
  {
    id: "github",
    name: "GitHub",
    icon: "https://cdn.simpleicons.org/github/f0f6fc",
    blurb: "REST + GraphQL over one store. Bearer or MCP-OAuth.",
    auth: "REST + GraphQL",
    accent: "#f0f6fc",
    spec: { kind: "url", path: "/openapi.json", authNote: "Bearer token (mint via /__token)" },
  },
  {
    id: "vercel",
    name: "Vercel",
    icon: "https://cdn.simpleicons.org/vercel/f0f6fc",
    blurb: "Projects, domains, deployments. Bearer / OAuth.",
    auth: "REST + OAuth",
    accent: "#f0f6fc",
    spec: { kind: "url", path: "/openapi.json", authNote: "OAuth2 · Authorization Code" },
  },
  {
    id: "google",
    name: "Google",
    icon: "https://cdn.simpleicons.org/google",
    blurb: "OIDC + the real Google API discovery proxy (Gmail, etc.).",
    auth: "OIDC + Discovery",
    accent: "#4285F4",
    spec: { kind: "googleDiscovery", path: "/discovery/v1/apis/gmail/v1/rest", authNote: "Google OAuth (override endpoints)" },
  },
  {
    id: "mcp",
    name: "GitHub MCP",
    icon: "🔌",
    blurb: "A real MCP server with GitHub tools. OAuth/DCR · bearer · query.",
    auth: "MCP server",
    accent: "#58a6ff",
    spec: { kind: "mcp", path: "/mcp", authNote: "MCP server (OAuth/DCR or bearer)" },
  },
];

export const serviceById = (id: string): Svc | undefined => SERVICES.find((s) => s.id === id);
