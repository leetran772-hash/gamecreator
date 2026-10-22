import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: true },
  build: { outDir: "dist", chunkSizeWarningLimit: 1000 },
});
