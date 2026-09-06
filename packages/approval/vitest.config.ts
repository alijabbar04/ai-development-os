import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["test/**/*.test.ts"],
  coverage: { provider: "v8", include: ["src/**/*.ts"],
    // Concrete adapter and synthetic issuer conformance is exercised separately.
    exclude: ["src/index.ts", "src/testing/**"], reporter: ["text", "json-summary"],
    thresholds: { statements: 90, branches: 80, functions: 95, lines: 90 }
  }
} });
