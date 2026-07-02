#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

function usage() {
  return [
    "Usage:",
    "  node tools/parity/diff.mjs real.json emulator.json",
    "",
    "Compares two API parity result files and reports structural divergences.",
  ].join("\n");
}

function severityRank(value) {
  return { HIGH: 0, MEDIUM: 1, INFO: 2 }[value] ?? 3;
}

function shapeOf(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return arrayShape(value);
  const valueType = typeof value;
  if (valueType === "string") return { type: "string" };
  if (valueType === "number") return { type: "number" };
  if (valueType === "boolean") return { type: "boolean" };
  if (valueType === "object") {
    const fields = {};
    for (const key of Object.keys(value).sort()) {
      fields[key] = shapeOf(value[key]);
    }
    return { type: "object", fields };
  }
  return { type: valueType };
}

function arrayShape(values) {
  if (values.length === 0) return { type: "array", item: null };
  return { type: "array", item: mergeShapes(values.map((value) => shapeOf(value))) };
}

function mergeShapes(shapes) {
  const [first, ...rest] = shapes;
  let merged = first;
  for (const next of rest) merged = mergeTwoShapes(merged, next);
  return merged;
}

function mergeTwoShapes(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.type !== right.type) return { type: "variant", variants: [left, right] };
  if (left.type === "object") {
    const fields = {};
    const keys = new Set([...Object.keys(left.fields), ...Object.keys(right.fields)]);
    for (const key of [...keys].sort()) fields[key] = mergeTwoShapes(left.fields[key], right.fields[key]);
    return { type: "object", fields };
  }
  if (left.type === "array") return { type: "array", item: mergeTwoShapes(left.item, right.item) };
  if (left.type === "variant") return { type: "variant", variants: [...left.variants, right] };
  return left;
}

function compareShape(left, right, path, issues, scopeLimited, labels) {
  if (!left && !right) return;
  if (!left || !right) {
    addIssue(
      issues,
      scopeLimited,
      "MEDIUM",
      path,
      `array item shape exists only on ${left ? labels.left : labels.right}`,
    );
    return;
  }

  if (left.type !== right.type) {
    addIssue(
      issues,
      scopeLimited,
      "HIGH",
      path,
      `JSON type differs: ${labels.left} has ${left.type}, ${labels.right} has ${right.type}`,
    );
    return;
  }

  if (left.type === "object") {
    const leftKeys = new Set(Object.keys(left.fields));
    const rightKeys = new Set(Object.keys(right.fields));
    for (const key of [...leftKeys].filter((key) => !rightKeys.has(key)).sort()) {
      addIssue(issues, scopeLimited, "MEDIUM", `${path}.${key}`, `extra field on ${labels.left}`);
    }
    for (const key of [...rightKeys].filter((key) => !leftKeys.has(key)).sort()) {
      addIssue(issues, scopeLimited, "MEDIUM", `${path}.${key}`, `extra field on ${labels.right}`);
    }
    for (const key of [...leftKeys].filter((key) => rightKeys.has(key)).sort()) {
      compareShape(left.fields[key], right.fields[key], `${path}.${key}`, issues, scopeLimited, labels);
    }
  } else if (left.type === "array") {
    compareShape(left.item, right.item, `${path}[]`, issues, scopeLimited, labels);
  } else if (left.type === "variant") {
    addIssue(issues, scopeLimited, "HIGH", path, "array item types vary within one side");
  }
}

function addIssue(issues, scopeLimited, severity, path, message) {
  issues.push({
    severity: scopeLimited ? "INFO" : severity,
    path,
    message,
    scopeLimited: Boolean(scopeLimited),
  });
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function probeMap(results) {
  const map = new Map();
  const probes = Array.isArray(results?.probes) ? results.probes : [];
  for (const probe of probes) {
    if (typeof probe?.name === "string" && !map.has(probe.name)) map.set(probe.name, probe);
  }
  return map;
}

function scopeLimited(left, right) {
  return Boolean(left?.scopeLimited || right?.scopeLimited);
}

function compareEnvelope(left, right, issues, limited, labels) {
  for (const key of ["name", "method", "path"]) {
    if (!(key in left)) addIssue(issues, limited, "HIGH", key, `missing envelope key on ${labels.left}`);
    if (!(key in right)) addIssue(issues, limited, "HIGH", key, `missing envelope key on ${labels.right}`);
  }

  for (const key of ["method", "path"]) {
    if (left[key] !== right[key]) {
      addIssue(
        issues,
        limited,
        "HIGH",
        key,
        `${key} differs: ${labels.left} has ${left[key]}, ${labels.right} has ${right[key]}`,
      );
    }
  }

  const leftSkipped = "skipped" in left;
  const rightSkipped = "skipped" in right;
  if (leftSkipped !== rightSkipped) {
    addIssue(issues, limited, "HIGH", "skipped", `skip state differs between ${labels.left} and ${labels.right}`);
  } else if (leftSkipped && rightSkipped && typeof left.skipped !== typeof right.skipped) {
    addIssue(issues, limited, "HIGH", "skipped", "skip reason type differs");
  }

  const leftFailure = "failure" in left;
  const rightFailure = "failure" in right;
  if (leftFailure !== rightFailure) {
    addIssue(issues, limited, "HIGH", "failure", `failure presence differs between ${labels.left} and ${labels.right}`);
  }

  if (!leftSkipped && !rightSkipped && left.status !== right.status) {
    addIssue(
      issues,
      limited,
      "HIGH",
      "status",
      `status differs: ${labels.left} has ${left.status}, ${labels.right} has ${right.status}`,
    );
  }
}

function compareChecks(left, right, issues, limited, labels) {
  const leftChecks = isObject(left.checks) ? left.checks : {};
  const rightChecks = isObject(right.checks) ? right.checks : {};
  const leftKeys = new Set(Object.keys(leftChecks));
  const rightKeys = new Set(Object.keys(rightChecks));

  for (const key of [...leftKeys].filter((key) => !rightKeys.has(key)).sort()) {
    addIssue(issues, limited, "HIGH", `checks.${key}`, `semantic check exists only on ${labels.left}`);
  }
  for (const key of [...rightKeys].filter((key) => !leftKeys.has(key)).sort()) {
    addIssue(issues, limited, "HIGH", `checks.${key}`, `semantic check exists only on ${labels.right}`);
  }
  for (const key of [...leftKeys].filter((key) => rightKeys.has(key)).sort()) {
    if (JSON.stringify(leftChecks[key]) !== JSON.stringify(rightChecks[key])) {
      addIssue(
        issues,
        limited,
        "HIGH",
        `checks.${key}`,
        `semantic check differs: ${labels.left} has ${JSON.stringify(leftChecks[key])}, ${labels.right} has ${JSON.stringify(rightChecks[key])}`,
      );
    }
  }
}

function compareProbe(name, left, right, labels) {
  const issues = [];
  const limited = scopeLimited(left, right);

  if (!left || !right) {
    addIssue(issues, limited, "HIGH", name, `probe exists only on ${left ? labels.left : labels.right}`);
    return issues;
  }

  compareEnvelope(left, right, issues, limited, labels);
  compareChecks(left, right, issues, limited, labels);

  if (!("skipped" in left) && !("skipped" in right) && !("failure" in left) && !("failure" in right)) {
    compareShape(shapeOf(left.headers ?? {}), shapeOf(right.headers ?? {}), "headers", issues, limited, labels);
    compareShape(shapeOf(left.response), shapeOf(right.response), "response", issues, limited, labels);
  }

  return issues;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function printReport(leftPath, rightPath, divergences) {
  const labels = { left: basename(leftPath), right: basename(rightPath) };
  const counts = { HIGH: 0, MEDIUM: 0, INFO: 0 };
  for (const item of divergences) counts[item.severity] += 1;

  console.log(`Compared ${labels.left} to ${labels.right}`);
  console.log(`Divergences: ${counts.HIGH} HIGH, ${counts.MEDIUM} MEDIUM, ${counts.INFO} INFO`);

  if (divergences.length === 0) {
    console.log("No divergences.");
    return;
  }

  const ordered = [...divergences].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.probe.localeCompare(b.probe) ||
      a.path.localeCompare(b.path),
  );
  let currentSeverity = null;
  for (const item of ordered) {
    if (item.severity !== currentSeverity) {
      currentSeverity = item.severity;
      console.log("");
      console.log(`${currentSeverity}:`);
    }
    const suffix = item.scopeLimited ? " (scopeLimited)" : "";
    console.log(`  ${item.probe} ${item.path}${suffix}: ${item.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.length !== 2) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const [leftPath, rightPath] = args;
  const labels = { left: basename(leftPath), right: basename(rightPath) };
  const left = await readJson(leftPath);
  const right = await readJson(rightPath);
  const leftProbes = probeMap(left);
  const rightProbes = probeMap(right);
  const names = [...new Set([...leftProbes.keys(), ...rightProbes.keys()])];
  const divergences = [];

  for (const name of names) {
    const issues = compareProbe(name, leftProbes.get(name), rightProbes.get(name), labels);
    for (const issue of issues) divergences.push({ probe: name, ...issue });
  }

  printReport(leftPath, rightPath, divergences);
  if (divergences.some((item) => item.severity === "HIGH")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
