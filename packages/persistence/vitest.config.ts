import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is re-exports only; the contract suite is executed by the
      // adapter packages (persistence-memory, persistence-sqlite), not by
      // this package's own unit tests, so it is excluded here.
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
