#!/usr/bin/env node
// Publish packages/emulate to npm as @executor-js/emulate (the name the
// executor repo consumes). The fork's release.yml publishes the upstream
// names; this is the manual path for the renamed package.
//
// What it does: builds with the real workspace manifest, then packs with the
// manifest temporarily rewritten — name swapped, workspace:* deps dropped
// (tsup's noExternal bundles them into dist) with their externals (jose,
// graphql) hoisted — and publishes the tarball. The manifest is always
// restored, even on failure.
//
// Auth: NPM_TOKEN env var, or `npm login` beforehand.
//   NPM_TOKEN=$(op item get "NPM Access Token" --fields credential --reveal) \
//     node scripts/publish-executor.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");
const pkgDir = join(root, "packages/emulate");
const pkgPath = join(pkgDir, "package.json");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: pkgDir, ...opts });

run("pnpm", ["--filter", "emulate", "build"], { cwd: root });

const original = readFileSync(pkgPath, "utf8");
const manifest = JSON.parse(original);
manifest.name = "@executor-js/emulate";
for (const [dep, range] of Object.entries(manifest.dependencies)) {
  if (range.startsWith("workspace:")) delete manifest.dependencies[dep];
}
// Externals of the bundled workspace packages (kept external by tsup).
manifest.dependencies.jose = "^6";
manifest.dependencies.graphql = "^16.9.0";

try {
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const tarball = `executor-js-emulate-${manifest.version}.tgz`;
  run("npm", ["pack", "--pack-destination", "/tmp"]);
  const publishArgs = ["publish", `/tmp/${tarball}`, "--access", "public"];
  if (process.env.NPM_TOKEN) {
    publishArgs.push(
      "--registry",
      "https://registry.npmjs.org",
      `--//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`,
    );
    run("npm", publishArgs, { env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" } });
  } else {
    run("npm", publishArgs);
  }
  console.log(`published @executor-js/emulate@${manifest.version}`);
} finally {
  writeFileSync(pkgPath, original);
}
