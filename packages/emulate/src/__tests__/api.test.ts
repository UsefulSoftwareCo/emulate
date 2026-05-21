import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const binaryPath = `/tmp/emulate-api-test-${process.pid}`;
let previousNativeBinary: string | undefined;

beforeAll(async () => {
  previousNativeBinary = process.env.EMULATE_NATIVE_BINARY;
  await execFileAsync("go", ["build", "-o", binaryPath, "./cmd/emulate"], { cwd: repoRoot });
  process.env.EMULATE_NATIVE_BINARY = binaryPath;
});

afterAll(async () => {
  if (previousNativeBinary == null) {
    delete process.env.EMULATE_NATIVE_BINARY;
  } else {
    process.env.EMULATE_NATIVE_BINARY = previousNativeBinary;
  }
  await rm(binaryPath, { force: true });
});

describe("createEmulator", () => {
  it("starts github through the native Go engine and returns a url", async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts multiple native services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");

    await Promise.all([github.close(), vercel.close()]);
  });

  it("returns the native advertised URL from explicit baseUrl templates", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14012,
      baseUrl: "https://{service}.example.test",
    });

    try {
      expect(github.url).toBe("https://github.example.test");
      await expect(readHealthBaseUrl(14012)).resolves.toBe("https://github.example.test");
    } finally {
      await github.close();
    }
  });

  it("returns the native advertised URL from environment fallback templates", async () => {
    const previousBaseUrl = process.env.EMULATE_BASE_URL;
    process.env.EMULATE_BASE_URL = "https://{service}.env.example.test";
    let github: Awaited<ReturnType<typeof createEmulator>> | undefined;

    try {
      github = await createEmulator({ service: "github", port: 14013 });
      expect(github.url).toBe("https://github.env.example.test");
      await expect(readHealthBaseUrl(14013)).resolves.toBe("https://github.env.example.test");
    } finally {
      await github?.close();
      if (previousBaseUrl == null) {
        delete process.env.EMULATE_BASE_URL;
      } else {
        process.env.EMULATE_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("returns seed baseUrl before explicit baseUrl", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14014,
      baseUrl: "https://ignored.example.test",
      seed: { github: { baseUrl: "https://seed-{service}.example.test" } },
    });

    try {
      expect(github.url).toBe("https://seed-github.example.test");
      await expect(readHealthBaseUrl(14014)).resolves.toBe("https://seed-github.example.test");
    } finally {
      await github.close();
    }
  });

  it("reset restarts the native process and reapplies seed config", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    await github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });

  it("cleans up startup resources when readiness times out", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "emulate-api-timeout-"));
    const seedTempDir = await mkdtemp(join(tmpdir(), "emulate-api-seed-cleanup-"));
    const fakeBinary = join(tempDir, "fake-emulate.js");
    const pidFile = join(tempDir, "pid");
    const previousFakePidFile = process.env.EMULATE_FAKE_PID_FILE;
    const previousTmpdir = process.env.TMPDIR;

    await writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.EMULATE_FAKE_PID_FILE, String(process.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    await chmod(fakeBinary, 0o755);

    process.env.EMULATE_NATIVE_BINARY = fakeBinary;
    process.env.EMULATE_FAKE_PID_FILE = pidFile;
    process.env.TMPDIR = seedTempDir;

    try {
      await expect(
        createEmulator({
          service: "github",
          port: 14030,
          startupTimeoutMs: 500,
          seed: { github: { users: [{ login: "seed-user" }] } },
        }),
      ).rejects.toThrow("Timed out waiting for native emulate process");
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(isProcessRunning(pid)).toBe(false);
      await expect(readdir(seedTempDir)).resolves.toHaveLength(0);
    } finally {
      process.env.EMULATE_NATIVE_BINARY = binaryPath;
      if (previousFakePidFile == null) {
        delete process.env.EMULATE_FAKE_PID_FILE;
      } else {
        process.env.EMULATE_FAKE_PID_FILE = previousFakePidFile;
      }
      if (previousTmpdir == null) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      await rm(tempDir, { recursive: true, force: true });
      await rm(seedTempDir, { recursive: true, force: true });
    }
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readHealthBaseUrl(port: number): Promise<string> {
  const health = (await fetch(`http://127.0.0.1:${port}/_emulate/health`).then((res) => res.json())) as {
    base_url: string;
  };
  return health.base_url;
}
