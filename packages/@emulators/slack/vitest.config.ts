import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@emulators/core": resolve(root, "packages/@emulators/core/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
