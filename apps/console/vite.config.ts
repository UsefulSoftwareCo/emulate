import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single self-contained index.html (JS+CSS inlined) so the emulator Worker can
// serve the whole console as one string.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
