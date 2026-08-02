import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Git processes against real temporary repositories are slower than
    // in-memory unit tests and the hostile-fixture matrix is large.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/testing/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        // Symlink and junction handling is platform-split: the junction paths
        // only execute on Windows and the POSIX symlink paths only elsewhere.
        // Each is covered on its own platform by the CI matrix.
        functions: 90,
        lines: 90,
      },
    },
  },
});
