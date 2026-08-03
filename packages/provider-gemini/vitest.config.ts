import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"], exclude: ["src/live/**"], coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/index.ts", "src/types.ts", "src/live/**"], reporter: ["text", "html", "lcov"], thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 } } } });
