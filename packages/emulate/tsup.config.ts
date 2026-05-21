import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

const addShebang = async () => {
  const entry = resolve(__dirname, "dist/index.js");
  const content = readFileSync(entry, "utf-8");
  const shebang = "#!/usr/bin/env node\n";
  writeFileSync(entry, shebang + content.replace(/^(#!\/usr\/bin\/env node\r?\n)+/, ""));
};

const shared = {
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    splitting: true,
    sourcemap: true,
    async onSuccess() {
      await addShebang();
    },
  },
  {
    ...shared,
    entry: ["src/api.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
  },
]);
