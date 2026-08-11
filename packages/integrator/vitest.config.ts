import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The disposable real-Git adapter is a testing-only subpath, covered by
      // its native fixture/mutation matrix. Match the repository-wide policy
      // of measuring production roots separately from `src/testing/**` seams.
      exclude: ["src/index.ts", "src/contracts.ts", "src/testing/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90
      }
    }
  }
});
