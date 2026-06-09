// Inlines the official provider brand SVGs (icons/*.svg, sourced from svgl.app and
// simple-icons) into a TS module the worker serves at /_emulate/icons/<service>.
// Run: node scripts/gen-icons.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "../icons");
const outPath = resolve(here, "../src/icons.ts");

const entries = readdirSync(iconsDir)
  .filter((f) => f.endsWith(".svg"))
  .sort()
  .map((f) => {
    const id = basename(f, ".svg");
    const svg = readFileSync(resolve(iconsDir, f), "utf8").trim();
    return `  ${JSON.stringify(id)}: ${JSON.stringify(svg)},`;
  });

const out =
  "// AUTO-GENERATED from icons/*.svg (official provider brand marks).\n" +
  "// Do not edit by hand; regenerate with `node scripts/gen-icons.mjs`.\n" +
  "export const SERVICE_ICONS: Record<string, string> = {\n" +
  entries.join("\n") +
  "\n};\n";

writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${entries.length} icons, ${out.length} bytes)`);
