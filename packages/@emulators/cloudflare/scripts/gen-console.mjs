// Inlines the built console SPA (apps/console/dist/index.html, produced by
// `pnpm --filter @emulators/console build`, single-file via vite-plugin-singlefile)
// into a TS module the worker imports. JSON-encoded so backticks / ${} in the
// bundled JS survive. Run: node scripts/gen-console.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "../../../../apps/console/dist/index.html");
const outPath = resolve(here, "../src/console-html.ts");

const html = readFileSync(htmlPath, "utf8");
const out =
  "// AUTO-GENERATED from apps/console (pnpm --filter @emulators/console build).\n" +
  "// Do not edit by hand; regenerate with `node scripts/gen-console.mjs`.\n" +
  "export const consoleHtml = " +
  JSON.stringify(html) +
  ";\n";
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${out.length} bytes from ${html.length} of HTML)`);
