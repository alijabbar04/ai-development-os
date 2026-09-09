import { describe, expect, it } from "vitest";
import type { AdoptedControlService } from "@ai-dev-os/control-service";
import { assertDesktopIpcEvent, parseDesktopRequest, sessionTokenMatches } from "../src/main/ipc-schema.js";
import { acceptsChildReadyMessage, sanitizeAdoptedService } from "../src/service/controller.js";
import { parseNativePlanningRequest } from "../src/shared/planning-ipc.js";

const token = "a".repeat(64);
const envelope = { schemaVersion: 1, requestId: "b".repeat(32), sessionToken: token };

describe("desktop IPC boundary", () => {
  it("accepts only the exact top-level sender, frame and session", () => {
    const valid = { senderId: 8, expectedSenderId: 8, frameUrl: "app-ai-powerhouse://workspace/renderer/index.html", expectedFrameUrl: "app-ai-powerhouse://workspace/renderer/index.html", topLevelFrame: true, sameSession: true };
    expect(() => assertDesktopIpcEvent(valid)).not.toThrow();
    for (const hostile of [
      { ...valid, senderId: 9 }, { ...valid, frameUrl: "app-ai-powerhouse://workspace/renderer/other.html" },
      { ...valid, topLevelFrame: false }, { ...valid, sameSession: false }, { ...valid, frameUrl: null },
    ]) expect(() => assertDesktopIpcEvent(hostile)).toThrow("SENDER_REJECTED");
  });

  it("exact-parses finite envelopes and rejects malformed or wrong-token input", () => {
    expect(parseDesktopRequest(envelope, "desktop-shell:snapshot", token)).toEqual(envelope);
    expect(() => parseDesktopRequest({ ...envelope, extra: true }, "desktop-shell:snapshot", token)).toThrow("INVALID_REQUEST");
    expect(() => parseDesktopRequest({ ...envelope, sessionToken: "c".repeat(64) }, "desktop-shell:snapshot", token)).toThrow("TOKEN_REJECTED");
    expect(() => parseDesktopRequest({ ...envelope, requestId: "not-an-id" }, "desktop-shell:snapshot", token)).toThrow("INVALID_REQUEST");
    expect(sessionTokenMatches(token, token)).toBe(true);
    expect(sessionTokenMatches(`${token}x`, token)).toBe(false);
  });

  it("requires exact benign preference input", () => {
    const preferences = { schemaVersion: 1, presentationMode: "developer", textScale: "large", welcomeDismissed: true };
    expect(parseDesktopRequest({ ...envelope, preferences }, "desktop-shell:set-preferences", token)).toMatchObject({ preferences });
    expect(() => parseDesktopRequest({ ...envelope, preferences: { ...preferences, secret: "forbidden" } }, "desktop-shell:set-preferences", token)).toThrow("INVALID_REQUEST");
  });

  it("accepts only bounded handover lookup coordinates on its read-only channel", () => {
    const planning = { kind: "handover", projectId: "prj:owned", handoverId: "planning-handover:owned" };
    expect(parseDesktopRequest({ ...envelope, planning }, "desktop-shell:planning-handover", token)).toMatchObject({ planning });
    for (const proposed of [{ ...planning, path: "C:/outside.json" }, { ...planning, handoverId: "../outside" }, { ...planning, actor: "owner" }, { kind: "command", command: { kind: "stop-project" } }]) {
      expect(() => parseDesktopRequest({ ...envelope, planning: proposed }, "desktop-shell:planning-handover", token)).toThrow("INVALID_REQUEST");
    }
    expect(() => parseDesktopRequest({ ...envelope, planning }, "desktop-shell:planning-command", token)).toThrow("INVALID_REQUEST");
  });

  it("rejects wrong-nonce and unexpected child envelopes", () => {
    const nonce = "d".repeat(32);
    expect(acceptsChildReadyMessage({ kind: "ready", launchNonce: nonce }, nonce)).toBe(true);
    expect(acceptsChildReadyMessage({ kind: "ready", launchNonce: "e".repeat(32) }, nonce)).toBe(false);
    expect(acceptsChildReadyMessage({ kind: "ready", launchNonce: nonce, descriptor: {} }, nonce)).toBe(false);
    expect(acceptsChildReadyMessage({ kind: "ready", launchNonce: nonce, bearerToken: "x" }, nonce)).toBe(false);
  });

  it("allows exact AI review subjects while rejecting caller authority and provider controls", () => {
    const review = { reviewId: "native-review:owned", action: "adopt-ai-proposal", title: "Adopt the saved proposed draft", detail: "Saved contribution and operator edits", subjectDigest: "a".repeat(64) };
    expect(parseNativePlanningRequest({ kind: "confirm", review })).toEqual({ kind: "confirm", review });
    for (const extra of [{ operatorConfirmed: true }, { executable: "outside.exe" }, { provider: "other-account" }, { sessionToken: "forged" }]) {
      expect(() => parseNativePlanningRequest({ kind: "confirm", review: { ...review, ...extra } })).toThrow("INVALID_REQUEST");
    }
    expect(() => parseNativePlanningRequest({ kind: "confirm", review: { ...review, action: "execute-ai-plan" } })).toThrow("INVALID_REQUEST");
    expect(() => parseNativePlanningRequest({ kind: "confirm", review: { ...review, subjectDigest: "not-bound" } })).toThrow("INVALID_REQUEST");
  });

  it("projects no bearer, nonce, port or descriptor path", () => {
    const bearer = "SYNTHETIC-BEARER-MUST-NOT-LEAK-123456789012";
    const adopted = {
      descriptor: {
        schemaVersion: 1, serviceVersion: "0.1.0", presentationMode: "normal", host: "127.0.0.1", port: 49152,
        processId: 42, startNonce: "f".repeat(32), bearerToken: bearer,
        issuedAt: "2026-09-07T10:00:00.000Z", expiresAt: "2026-09-07T10:30:00.000Z",
      },
      presentationMode: "normal",
      runningSessions: 0,
    } as AdoptedControlService;
    const projected = sanitizeAdoptedService(adopted, "2026-09-07T10:00:01.000Z");
    const json = JSON.stringify(projected);
    expect(json).not.toContain(bearer);
    expect(json).not.toContain("startNonce");
    expect(json).not.toContain("bearerToken");
    expect(json).not.toContain("49152");
    expect(projected.verification).toBe("identity-verified-connection-closed");
    expect(projected.authority).toBe("none");
    expect(projected.commands).toEqual([]);
  });
});
