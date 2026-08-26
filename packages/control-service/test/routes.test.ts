import { describe, expect, it } from "vitest";
import {
  CONTROL_COMMAND_COUNT,
  CONTROL_COMMAND_REGISTRY,
  CONTROL_ROUTE_COUNT,
  CONTROL_ROUTE_REGISTRY,
  controlAuthorityForPresentationMode,
  parseBoundedQuery,
} from "../src/index.js";

describe("C4 route and command inventory", () => {
  it("enumerates exactly two reads and zero commands", () => {
    expect(CONTROL_ROUTE_COUNT).toBe(2);
    expect(CONTROL_ROUTE_REGISTRY).toEqual([
      { method: "GET", path: "/v1/health", authenticated: false, checkpoint: "C4" },
      { method: "GET", path: "/v1/session", authenticated: true, checkpoint: "C4" },
    ]);
    expect(CONTROL_ROUTE_REGISTRY.every((route) => route.method === "GET")).toBe(true);
    expect(CONTROL_COMMAND_COUNT).toBe(0);
    expect(CONTROL_COMMAND_REGISTRY).toEqual([]);
    expect(JSON.stringify(CONTROL_ROUTE_REGISTRY)).not.toMatch(/usage\.refresh|provider|credential|workspace|git|task|command/iu);
  });

  it("keeps Normal and Developer authority byte-identical", () => {
    expect(controlAuthorityForPresentationMode("normal")).toBe(controlAuthorityForPresentationMode("developer"));
    expect(controlAuthorityForPresentationMode("normal")).toMatchObject({ productionEnabled: false, routeCount: 2, commandCount: 0 });
    expect(() => controlAuthorityForPresentationMode("admin" as "normal")).toThrow(/Unsupported/u);
  });

  it("requires every exact query key once", () => {
    expect(parseBoundedQuery("/v1/example?profileId=profile-a", ["profileId"])).toEqual({ profileId: "profile-a" });
    expect(() => parseBoundedQuery("/v1/example", ["profileId"])).toThrow();
    expect(() => parseBoundedQuery("/v1/example?other=value", ["profileId"])).toThrow();
    expect(() => parseBoundedQuery("/v1/example?profileId=a&profileId=b", ["profileId"])).toThrow();
  });
});
