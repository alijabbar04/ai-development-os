import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // index.ts is re-exports only; the contract suites are the thing being
      // exported for other packages to run, not the thing under measurement.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/testing/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        // Process-tree termination is platform-split by construction: the
        // POSIX process-group path cannot execute on Windows and the Windows
        // taskkill path cannot execute on Linux, so neither host covers both.
        // Each is covered on its own platform by the CI matrix. This matches
        // the precedent set by @ai-dev-os/provider-ollama.
        functions: 90,
        lines: 90,
      },
    },
  },
});
