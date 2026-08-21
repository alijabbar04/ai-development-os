import { describe, expect, it } from "vitest";
import type { CredentialResponse } from "@ai-dev-os/credential-ui";
import { withCredentialWriteWatchdog } from "../src/main/ipc.js";
import { resolveCredentialProtocolRequest } from "../src/main/protocol.js";

describe("custom protocol allowlist", () => {
  const root = "C:\\bounded\\renderer\\credential";
  it("accepts only the exact host and three packaged files", () => {
    expect(resolveCredentialProtocolRequest("app-credential://entry/", root)).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8" });
    expect(resolveCredentialProtocolRequest("app-credential://entry/index.html", root)).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8" });
    expect(resolveCredentialProtocolRequest("app-credential://entry/entry.js", root)).toMatchObject({ status: 200, contentType: "text/javascript; charset=utf-8" });
    expect(resolveCredentialProtocolRequest("app-credential://entry/entry.css", root)).toMatchObject({ status: 200, contentType: "text/css; charset=utf-8" });
  });

  it("rejects traversal, encoded traversal, unexpected files, query/hash/userinfo/port, origin, and malformed URLs", () => {
    for (const url of [
      "app-credential://entry/../main.js",
      "app-credential://entry/%2e%2e/main.js",
      "app-credential://entry/%2fetc",
      "app-credential://entry/entry.js?x=1",
      "app-credential://entry/index.html#x",
      "app-credential://other/index.html",
      "app-credential://user@entry/index.html",
      "app-credential://entry:99/index.html",
      "https://entry/index.html",
      "not a url",
    ]) expect(resolveCredentialProtocolRequest(url, root).status).not.toBe(200);
  });
});

describe("finite write watchdog", () => {
  it("returns the operation result before the deadline", async () => {
    const success: CredentialResponse = Object.freeze({ schemaVersion: 1, requestId: "1".repeat(32), ok: true, kind: "cancelled" });
    expect(await withCredentialWriteWatchdog("1".repeat(32), Promise.resolve(success), 50)).toBe(success);
  });

  it("reports an interrupted response as unknown while leaving the atomic operation running", async () => {
    let finish!: (value: CredentialResponse) => void;
    const operation = new Promise<CredentialResponse>((resolve) => { finish = resolve; });
    let timedOut = 0;
    const result = await withCredentialWriteWatchdog("2".repeat(32), operation, 5, () => { timedOut += 1; });
    expect(result).toEqual({ schemaVersion: 1, requestId: "2".repeat(32), ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false });
    expect(timedOut).toBe(1);
    const completed: CredentialResponse = Object.freeze({ schemaVersion: 1, requestId: "2".repeat(32), ok: true, kind: "cancelled" });
    finish(completed);
    await expect(operation).resolves.toBe(completed);
  });

  it("uses its inert default timeout observer when none is supplied", async () => {
    const operation = new Promise<CredentialResponse>(() => undefined);
    await expect(withCredentialWriteWatchdog("3".repeat(32), operation, 1)).resolves.toEqual({ schemaVersion: 1, requestId: "3".repeat(32), ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false });
  });
});
