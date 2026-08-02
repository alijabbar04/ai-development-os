import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is re-exports only; the contract suite executes inside the
      // adapter package (artifact-store-local), not in this package's tests.
      exclude: ["src/index.ts", "src/testing/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 98,
        lines: 90,
      },
    },
  },
});
