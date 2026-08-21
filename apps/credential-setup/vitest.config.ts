import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/main/**/*.ts"],
      exclude: ["src/main/main.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 90, branches: 85, functions: 100, lines: 95 },
    },
  },
});
