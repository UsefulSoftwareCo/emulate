import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Hono } from "./http.js";
import type { AppEnv } from "./middleware/auth.js";

// Read the cosmetic font/favicon assets lazily and defensively: on a real
// filesystem (Node/Bun hosts) this serves them; on filesystem-less runtimes
// (e.g. Cloudflare Workers) the read fails and the route 404s, but — crucially —
// importing this module touches neither fs NOR import.meta.url at load time
// (workerd leaves import.meta.url undefined, which would crash `fileURLToPath`),
// so `createServer` boots everywhere. API emulation never needs these assets.
const assetCache = new Map<string, Buffer | null>();
function loadAsset(name: string): Buffer | null {
  if (assetCache.has(name)) return assetCache.get(name)!;
  let buf: Buffer | null = null;
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    buf = readFileSync(join(dir, "fonts", name));
  } catch {
    buf = null;
  }
  assetCache.set(name, buf);
  return buf;
}

const FONT_NAMES = new Set(["geist-sans.woff2", "GeistPixel-Square.woff2"]);

export function registerFontRoutes(app: Hono<AppEnv>): void {
  app.get("/_emulate/fonts/:name", (c) => {
    const name = c.req.param("name");
    if (!FONT_NAMES.has(name)) return c.notFound();
    const buf = loadAsset(name);
    if (!buf) return c.notFound();
    return new Response(buf, {
      headers: {
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  app.get("/_emulate/favicon.ico", (c) => {
    const buf = loadAsset("favicon.ico");
    if (!buf) return c.notFound();
    return new Response(buf, {
      headers: {
        "Content-Type": "image/x-icon",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
}
