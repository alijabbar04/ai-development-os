import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/testing/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 95, branches: 90, functions: 100, lines: 95 },
    },
  },
});
