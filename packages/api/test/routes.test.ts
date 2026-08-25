import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_COMMAND_COUNT,
  API_COMMAND_REGISTRY,
  API_ROUTE_COUNT,
  API_ROUTE_REGISTRY,
  apiAuthorityForPresentationMode,
} from "../src/index.js";

describe("route-free Stage 20A authority", () => {
  it("enumerates exactly zero routes and zero commands", () => {
    expect(API_ROUTE_COUNT).toBe(0);
    expect(API_COMMAND_COUNT).toBe(0);
    expect(API_ROUTE_REGISTRY).toEqual([]);
    expect(API_COMMAND_REGISTRY).toEqual([]);
    expect(Object.isFrozen(API_ROUTE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(API_COMMAND_REGISTRY)).toBe(true);
  });

  it("gives Normal and Developer modes the identical disabled authority", () => {
    const normal = apiAuthorityForPresentationMode("normal");
    const developer = apiAuthorityForPresentationMode("developer");
    expect(normal).toBe(developer);
    expect(normal).toEqual({ productionEnabled: false, routeCount: 0, commandCount: 0 });
    expect(Object.isFrozen(normal)).toBe(true);
    expect(() => apiAuthorityForPresentationMode("unsafe")).toThrow(/must be one of/u);
  });

  it("contains no HTTP verb or command identifier", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/routes.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/u);
    expect(source).not.toContain("usage.refresh");
    expect(source).not.toMatch(/\b(?:createServer|listen|bind)\s*\(/u);
  });
});
