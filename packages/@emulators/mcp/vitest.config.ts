import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The MCP package ships behavior exercised through the GitHub emulator's MCP
    // surface tests; it has no standalone test files of its own.
    passWithNoTests: true,
  },
});
