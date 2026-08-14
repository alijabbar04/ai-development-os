import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/testing/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 90, branches: 85, functions: 95, lines: 90 },
    },
  },
});
