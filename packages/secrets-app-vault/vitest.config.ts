import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/testing/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 97, branches: 95, functions: 100, lines: 97 },
    },
  },
});
