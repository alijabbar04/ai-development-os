import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlServiceHandle } from "../src/index.js";
import { httpGet } from "./http-helpers.js";
import { projectionDataset, startControlServiceForTest } from "./testing.js";
import { createCanonicalTemporaryRoot } from "./temporary-root.js";

const NOW = "2026-08-26T10:00:00.000Z";
const roots: string[] = [];
const handles: ControlServiceHandle[] = [];
const NORMAL_LEAKAGE_PATTERNS = Object.freeze([
  /"(?:sourceFingerprint|[^"\n]*fingerprint|borrowedOwner[^"\n]*|owner(?:Id|Identity|Email|Name|Account))"|authorization\s*header/iu,
  /(?:usage|route|admission|orchestration)\.[a-z0-9.-]+/u,
  /sha256:|\b(?:att|lease|trc|ctx)-|\b(?:hnd|dec):|basis[-\s]+points?|\b429\b/iu,
  /sk-ant-|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+|[A-Za-z]:\\|\\\\/u,
  /[A-Za-z0-9_-]{43}/u,
]);

function matchingNormalLeaks(text: string): readonly string[] {
  return NORMAL_LEAKAGE_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

async function start(mode: "normal" | "developer" = "normal"): Promise<ControlServiceHandle> {
  const storageRoot = await createCanonicalTemporaryRoot("ai-dev-os-c5-routes-");
  roots.push(storageRoot);
  const handle = await startControlServiceForTest({
    storageRoot,
    clock: () => NOW,
    random: (size) => Buffer.alloc(size, mode === "normal" ? 31 : 32),
    presentationMode: mode,
    projectionDataset: projectionDataset(NOW),
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) {
    try { await handle.close(); } catch { /* cleanup assertions live in lifecycle tests */ }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("C5 authenticated projection routes", () => {
  it("serves exactly four deterministic projections with monotonic C2 envelopes", async () => {
    const handle = await start();
    const routes = [
      "/v1/projections/health",
      "/v1/projections/usage.policyConstants",
      "/v1/projections/usage.profiles?profileId=profile-owned",
      "/v1/projections/routing.latest?taskId=task-one",
    ];
    const results = [];
    for (const route of routes) results.push(await httpGet(handle.descriptor, route));
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    expect(results.map((result) => (result.json as { sequence: number }).sequence)).toEqual([1, 2, 3, 4]);
    for (const result of results) {
      expect(result.json).toMatchObject({
        schemaVersion: 1,
        serverNow: NOW,
        productionEnabled: false,
        ok: true,
        kind: "projection",
        confidence: "current",
        staleReason: null,
      });
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const healthPayload = (results[0]?.json as { payload: Record<string, unknown> }).payload;
    expect(healthPayload["sequence"]).toBe(1);
    expect(healthPayload).not.toHaveProperty("pid");
  });

  it("requires authentication and structurally rejects mode as request input", async () => {
    const handle = await start();
    const unauthenticated = await httpGet(handle.descriptor, "/v1/projections/health", { token: null });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.text).not.toContain(handle.descriptor.bearerToken);

    const mode = await httpGet(handle.descriptor, "/v1/projections/health?mode=developer");
    expect(mode.statusCode).toBe(400);
    expect(mode.json).toMatchObject({
      kind: "transport-refusal",
      transportRefusal: { code: "QUERY_REFUSED", details: null },
    });
  });

  it("uses a finite C2 refusal for an unavailable named record", async () => {
    const handle = await start();
    const profile = await httpGet(handle.descriptor, "/v1/projections/usage.profiles?profileId=profile-other");
    const routing = await httpGet(handle.descriptor, "/v1/projections/routing.latest?taskId=task-other");
    for (const result of [profile, routing]) {
      expect(result.statusCode).toBe(503);
      expect(result.json).toMatchObject({
        schemaVersion: 1,
        serverNow: NOW,
        productionEnabled: false,
        ok: false,
        kind: "refused",
        refusal: { code: "SERVICE_NOT_READY", details: null },
      });
    }
  });

  it("selects Developer presentation only at composition while preserving route authority", async () => {
    const handle = await start("developer");
    const health = await httpGet(handle.descriptor, "/v1/projections/health");
    const usage = await httpGet(handle.descriptor, "/v1/projections/usage.profiles?profileId=profile-owned");
    const routing = await httpGet(handle.descriptor, "/v1/projections/routing.latest?taskId=task-one");
    expect((health.json as { payload: Record<string, unknown> }).payload).toMatchObject({
      pid: process.pid,
      nonceReference: `launch:${handle.descriptor.startNonce}`,
    });
    expect((usage.json as { payload: Record<string, unknown> }).payload).toHaveProperty("profileId", "profile-owned");
    expect((routing.json as { payload: Record<string, unknown> }).payload).toHaveProperty("decisionId", "decision-one");
  });

  it("keeps the complete Normal response corpus free of secret and mechanism shapes", async () => {
    const handle = await start();
    const results = await Promise.all([
      httpGet(handle.descriptor, "/v1/projections/health"),
      httpGet(handle.descriptor, "/v1/projections/usage.policyConstants"),
      httpGet(handle.descriptor, "/v1/projections/usage.profiles?profileId=profile-owned"),
      httpGet(handle.descriptor, "/v1/projections/routing.latest?taskId=task-one"),
    ]);
    const body = results.map((result) => result.text).join("\n");
    expect(body).not.toContain(handle.descriptor.bearerToken);
    expect(matchingNormalLeaks(body)).toEqual([]);

    for (const positiveControl of [
      '"sourceFingerprint"', '"ownerEmail"', "usage.stale.refused", "sha256:abc",
      "lease-handle", "basis points", `Bearer ${"x".repeat(43)}`,
      handle.descriptor.bearerToken,
      ["sk", "ant", "api03", "A".repeat(30)].join("-"), "C:\\private\\path",
    ]) {
      expect(matchingNormalLeaks(positiveControl), positiveControl).not.toEqual([]);
    }
  });
});
