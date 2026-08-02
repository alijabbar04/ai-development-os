import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Claude-CLI fixtures are spawned as child processes through the
    // process broker, and managed workspaces are real Git repositories.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is re-exports only.
      exclude: ["src/index.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        statements: 90,
        branches: 80,
        // Platform-split executable discovery (Windows shim refusal versus
        // POSIX permission-bit checks) cannot both execute on one host; each
        // half is covered on its own platform by the CI matrix, following the
        // @ai-dev-os/workspace precedent.
        functions: 90,
        lines: 90,
      },
    },
  },
});
