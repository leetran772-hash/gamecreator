import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  server: { host: true, watch: { ignored: ["**/.claude/**", "**/build/**", "**/qa-output/**"] } },
  build: { outDir: "dist", chunkSizeWarningLimit: 1000 },
  test: { exclude: [...configDefaults.exclude, ".claude/**", "build/**"] },
});
