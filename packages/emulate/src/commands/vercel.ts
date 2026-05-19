import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_VERCEL_SERVICES = ["aws", "resend"] as const;
const DEFAULT_REWRITE = {
  source: "/emulate/:path*",
  destination: "/api/emulate?path=:path*",
};

export interface VercelInitOptions {
  service?: string;
  force?: boolean;
  cwd?: string;
  version: string;
}

export interface VercelScaffoldResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  services: string[];
}

type VercelConfig = Record<string, unknown>;

export function vercelInitCommand(options: VercelInitOptions): void {
  try {
    const result = createVercelScaffold(options);
    for (const file of result.created) {
      console.log(`Created ${file}`);
    }
    for (const file of result.updated) {
      console.log(`Updated ${file}`);
    }
    for (const file of result.unchanged) {
      console.log(`Skipped existing ${file}`);
    }
    console.log(`\nVercel Go Function scaffold ready for: ${result.services.join(", ")}`);
    console.log(
      "State uses warm in-memory stores by default. Cold starts reset state, and concurrent instances can diverge.",
    );
    console.log(
      "Add a vercel.Persistence implementation in api/emulate.go when snapshots need to survive cold starts.",
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function createVercelScaffold(options: VercelInitOptions): VercelScaffoldResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const services = parseServiceList(options.service);
  const result: VercelScaffoldResult = {
    created: [],
    updated: [],
    unchanged: [],
    services,
  };

  mkdirSync(join(cwd, "api"), { recursive: true });

  writeFileIfAllowed(cwd, "api/emulate.go", renderHandler(services), options.force ?? false, result);
  updateGoMod(cwd, options.version, result);
  updateVercelConfig(cwd, options.force ?? false, result);

  return result;
}

function parseServiceList(input: string | undefined): string[] {
  if (!input || input.trim() === "" || input.trim().toLowerCase() === "all") {
    return [...SUPPORTED_VERCEL_SERVICES];
  }
  const seen = new Set<string>();
  const services: string[] = [];
  for (const raw of input.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) {
      continue;
    }
    if (!SUPPORTED_VERCEL_SERVICES.includes(name as (typeof SUPPORTED_VERCEL_SERVICES)[number])) {
      throw new Error(
        `The Vercel Go Function scaffold currently supports native services: ${SUPPORTED_VERCEL_SERVICES.join(", ")}`,
      );
    }
    seen.add(name);
    services.push(name);
  }
  if (services.length === 0) {
    return [...SUPPORTED_VERCEL_SERVICES];
  }
  return services;
}

function writeFileIfAllowed(
  cwd: string,
  relativePath: string,
  content: string,
  force: boolean,
  result: VercelScaffoldResult,
): void {
  const target = join(cwd, relativePath);
  if (existsSync(target) && !force) {
    result.unchanged.push(relativePath);
    return;
  }
  const existed = existsSync(target);
  writeFileSync(target, content, "utf-8");
  if (existed) {
    result.updated.push(relativePath);
  } else {
    result.created.push(relativePath);
  }
}

function updateGoMod(cwd: string, version: string, result: VercelScaffoldResult): void {
  const relativePath = "go.mod";
  const target = join(cwd, relativePath);
  const moduleVersion = normalizeGoModuleVersion(version);
  if (!existsSync(target)) {
    writeFileSync(target, renderGoMod(moduleVersion), "utf-8");
    result.created.push(relativePath);
    return;
  }

  const content = readFileSync(target, "utf-8");
  if (hasEmulateRequirement(content)) {
    result.unchanged.push(relativePath);
    return;
  }

  writeFileSync(target, addEmulateRequirement(content, moduleVersion), "utf-8");
  result.updated.push(relativePath);
}

function hasEmulateRequirement(content: string): boolean {
  return /^\s*(?:require\s+)?github\.com\/vercel-labs\/emulate\s+v\S+/m.test(content);
}

function addEmulateRequirement(content: string, moduleVersion: string): string {
  const dependency = `github.com/vercel-labs/emulate ${moduleVersion}`;
  if (/^require\s*\(/m.test(content)) {
    return content.replace(/^require\s*\(\s*\n/m, (match) => `${match}\t${dependency}\n`);
  }
  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}\nrequire ${dependency}\n`;
}

function updateVercelConfig(cwd: string, force: boolean, result: VercelScaffoldResult): void {
  const relativePath = "vercel.json";
  const target = join(cwd, relativePath);
  let config: VercelConfig = {
    $schema: "https://openapi.vercel.sh/vercel.json",
  };
  let existed = false;
  if (existsSync(target)) {
    existed = true;
    try {
      config = JSON.parse(readFileSync(target, "utf-8")) as VercelConfig;
    } catch (err) {
      throw new Error(`Failed to parse ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rewrites = config.rewrites;
  if (rewrites !== undefined && !Array.isArray(rewrites)) {
    throw new Error(`${relativePath} rewrites must be an array to add the emulate preview route`);
  }

  const rewriteList = rewrites ?? [];
  const sameSource = rewriteList.find((entry) => isRewrite(entry) && entry.source === DEFAULT_REWRITE.source);
  if (sameSource && isRewrite(sameSource) && sameSource.destination !== DEFAULT_REWRITE.destination) {
    throw new Error(`${relativePath} already has a rewrite for ${DEFAULT_REWRITE.source}`);
  }

  const hasRewrite = rewriteList.some(isDefaultRewrite);
  if (hasRewrite && !force) {
    const orderedRewriteList = moveExistingRewriteBeforeCatchAll(rewriteList);
    if (orderedRewriteList === rewriteList) {
      result.unchanged.push(relativePath);
      return;
    }
    config.rewrites = orderedRewriteList;
  } else {
    config.rewrites = hasRewrite ? rewriteList : insertRewrite(rewriteList);
  }

  if (!("$schema" in config)) {
    config.$schema = "https://openapi.vercel.sh/vercel.json";
  }
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  if (existed) {
    result.updated.push(relativePath);
  } else {
    result.created.push(relativePath);
  }
}

function insertRewrite(rewriteList: unknown[]): unknown[] {
  const catchAllIndex = rewriteList.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  if (catchAllIndex < 0) {
    return [...rewriteList, DEFAULT_REWRITE];
  }
  return [...rewriteList.slice(0, catchAllIndex), DEFAULT_REWRITE, ...rewriteList.slice(catchAllIndex)];
}

function moveExistingRewriteBeforeCatchAll(rewriteList: unknown[]): unknown[] {
  const rewriteIndex = rewriteList.findIndex(isDefaultRewrite);
  const catchAllIndex = rewriteList.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  if (rewriteIndex < 0 || catchAllIndex < 0 || rewriteIndex < catchAllIndex) {
    return rewriteList;
  }
  const ordered = [...rewriteList];
  const [rewrite] = ordered.splice(rewriteIndex, 1);
  const updatedCatchAllIndex = ordered.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  ordered.splice(updatedCatchAllIndex, 0, rewrite);
  return ordered;
}

function isCatchAllSource(source: string): boolean {
  const value = source.trim();
  return value === "/(.*)" || /^\/:[A-Za-z_][\w-]*\*$/.test(value) || /^\/:[A-Za-z_][\w-]*\(\.\*\)$/.test(value);
}

function isDefaultRewrite(value: unknown): boolean {
  return (
    isRewrite(value) && value.source === DEFAULT_REWRITE.source && value.destination === DEFAULT_REWRITE.destination
  );
}

function isRewrite(value: unknown): value is { source: string; destination: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  return typeof maybe.source === "string" && typeof maybe.destination === "string";
}

function renderHandler(services: string[]): string {
  const serviceList = services.map((service) => `"${service}"`).join(", ");
  return `package handler

import (
\t"net/http"

\temulate "github.com/vercel-labs/emulate/vercel"
)

var emulateHandler = emulate.NewHandler(emulate.Options{
\tServices: []string{${serviceList}},
})

func Handler(w http.ResponseWriter, r *http.Request) {
\temulateHandler.ServeHTTP(w, r)
}
`;
}

function normalizeGoModuleVersion(version: string): string {
  const moduleVersion = version.startsWith("v") ? version : `v${version}`;
  return moduleVersion;
}

function renderGoMod(moduleVersion: string): string {
  return `module emulate-vercel-preview

go 1.24

require github.com/vercel-labs/emulate ${moduleVersion}
`;
}
