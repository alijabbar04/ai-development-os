import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/{main,service,presentation}/**/*.ts"],
      exclude: ["src/main/startup.ts", "src/service/child.ts", "src/testing/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
