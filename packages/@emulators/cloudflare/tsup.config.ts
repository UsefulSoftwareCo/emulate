import { defineConfig } from "tsup";

// Bundle the engine (core) + the bundled service plugins into a single CF-ready
// Worker module. The deps import Node builtins both bare (`crypto`, `path`) and
// prefixed (`node:fs`); this plugin normalizes every builtin to a `node:`-prefixed
// EXTERNAL import so Cloudflare's nodejs_compat resolves them (and esbuild doesn't
// try to bundle them). platform:neutral so no Node shims are injected.
const NODE_BUILTINS = new Set([
  "assert", "buffer", "crypto", "events", "fs", "fs/promises", "http", "https",
  "net", "os", "path", "querystring", "stream", "string_decoder", "tls", "url",
  "util", "zlib", "module", "async_hooks", "perf_hooks",
]);

export default defineConfig({
  entry: { worker: "src/worker.ts", index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  noExternal: [/^@emulators\//],
  platform: "neutral",
  target: "es2022",
  esbuildPlugins: [
    {
      name: "node-builtins-external",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const bare = args.path.replace(/^node:/, "");
          if (NODE_BUILTINS.has(bare)) return { path: `node:${bare}`, external: true };
          return undefined;
        });
      },
    },
  ],
});
