import { describe, expect, it } from "vitest";
import { cleanupListenerFixtures } from "./listener-fixture-cleanup.js";

function deferredClose(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("listener fixture cleanup ownership", () => {
  it("cannot consume a later fixture's queued root when an earlier close finishes late", async () => {
    const oldClose = deferredClose();
    const closed: string[] = [], removed: string[] = [];
    const oldHandle = { async close() { closed.push("old"); await oldClose.promise; } };
    const nextHandle = { async close() { closed.push("next"); } };
    const handles = [oldHandle], roots = ["owned-old-root"];

    const oldCleanup = cleanupListenerFixtures(handles, roots, async (value) => { removed.push(value); });
    // This is the ordering after a hook times out: another fixture queues its
    // own resources while the old close is still pending. No clock is needed.
    handles.push(nextHandle);
    roots.push("owned-next-root");
    oldClose.release();
    await oldCleanup;

    expect(closed).toEqual(["old"]);
    expect(removed).toEqual(["owned-old-root"]);
    expect(handles).toEqual([nextHandle]);
    expect(roots).toEqual(["owned-next-root"]);
  });

  it("keeps two overlapping cleanups bound to their own roots even when closes finish in reverse order", async () => {
    const oldClose = deferredClose(), nextClose = deferredClose();
    const removed: { owner: string; root: string }[] = [];
    const handles = [{ async close() { await oldClose.promise; } }], roots = ["owned-old-root"];
    const oldCleanup = cleanupListenerFixtures(handles, roots, async (root) => { removed.push({ owner: "old", root }); });
    handles.push({ async close() { await nextClose.promise; } });
    roots.push("owned-next-root");
    const nextCleanup = cleanupListenerFixtures(handles, roots, async (root) => { removed.push({ owner: "next", root }); });

    nextClose.release();
    await nextCleanup;
    oldClose.release();
    await oldCleanup;

    expect(removed).toEqual([
      { owner: "next", root: "owned-next-root" },
      { owner: "old", root: "owned-old-root" },
    ]);
    expect(handles).toEqual([]);
    expect(roots).toEqual([]);
  });

  it("preserves reverse close order and continues exact root cleanup after a close rejects", async () => {
    const events: string[] = [];
    const handles = [
      { async close() { events.push("close:first"); } },
      { async close() { events.push("close:second"); throw new Error("owned close failure"); } },
      { async close() { events.push("close:third"); } },
    ];
    const roots = ["owned-first-root", "owned-second-root"];
    await cleanupListenerFixtures(handles, roots, async (value) => { events.push(`remove:${value}`); });
    await cleanupListenerFixtures(handles, roots, async (value) => { events.push(`unexpected:${value}`); });

    expect(events).toEqual([
      "close:third", "close:second", "close:first", "remove:owned-first-root", "remove:owned-second-root",
    ]);
    expect(handles).toEqual([]);
    expect(roots).toEqual([]);
  });
});
