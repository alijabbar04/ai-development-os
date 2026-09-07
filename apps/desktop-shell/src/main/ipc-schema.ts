import { timingSafeEqual } from "node:crypto";
import type {
  DesktopPreferenceUpdate,
  DesktopPreferences,
  DesktopRequestChannel,
  DesktopRequestEnvelope,
  DesktopPlanningRequest,
} from "../shared/contracts.js";
import { parsePlanningQuery } from "../shared/planning-ipc.js";

const REQUEST_ID = /^[a-f0-9]{32}$/u;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) throw new Error("INVALID_REQUEST");
  return record;
}

export function sessionTokenMatches(left: unknown, right: string): boolean {
  if (typeof left !== "string" || left.length !== right.length) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try { return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes); }
  finally { leftBytes.fill(0); rightBytes.fill(0); }
}

function parseBase(record: Record<string, unknown>, expectedToken: string): DesktopRequestEnvelope {
  if (record["schemaVersion"] !== 1 || typeof record["requestId"] !== "string" || !REQUEST_ID.test(record["requestId"])) throw new Error("INVALID_REQUEST");
  if (!sessionTokenMatches(record["sessionToken"], expectedToken)) throw new Error("TOKEN_REJECTED");
  return Object.freeze({ schemaVersion: 1, requestId: record["requestId"], sessionToken: expectedToken });
}

export function parseDesktopRequest(raw: unknown, channel: DesktopRequestChannel, expectedToken: string): DesktopRequestEnvelope | DesktopPreferenceUpdate | DesktopPlanningRequest {
  const planningKind = channel === "desktop-shell:planning-snapshot" ? "snapshot" : channel === "desktop-shell:planning-command" ? "command" : channel === "desktop-shell:planning-observe" ? "observe" : channel === "desktop-shell:planning-handover" ? "handover" : null;
  if (planningKind !== null) {
    const record = exactRecord(raw, ["schemaVersion", "requestId", "sessionToken", "planning"]), base = parseBase(record, expectedToken), planning = parsePlanningQuery(record["planning"]);
    if (planning.kind !== planningKind) throw new Error("INVALID_REQUEST");
    return Object.freeze({ ...base, planning });
  }
  if (channel === "desktop-shell:set-preferences") {
    const record = exactRecord(raw, ["schemaVersion", "requestId", "sessionToken", "preferences"]);
    const base = parseBase(record, expectedToken);
    const preferences = exactRecord(record["preferences"], ["schemaVersion", "presentationMode", "textScale", "welcomeDismissed"]);
    if (preferences["schemaVersion"] !== 1) throw new Error("INVALID_REQUEST");
    if (preferences["presentationMode"] !== "normal" && preferences["presentationMode"] !== "developer") throw new Error("INVALID_REQUEST");
    if (preferences["textScale"] !== "standard" && preferences["textScale"] !== "large") throw new Error("INVALID_REQUEST");
    if (typeof preferences["welcomeDismissed"] !== "boolean") throw new Error("INVALID_REQUEST");
    const parsed: DesktopPreferences = Object.freeze({
      schemaVersion: 1,
      presentationMode: preferences["presentationMode"],
      textScale: preferences["textScale"],
      welcomeDismissed: preferences["welcomeDismissed"],
    });
    return Object.freeze({ ...base, preferences: parsed });
  }
  const record = exactRecord(raw, ["schemaVersion", "requestId", "sessionToken"]);
  return parseBase(record, expectedToken);
}

export interface DesktopIpcEventFacts {
  readonly senderId: number;
  readonly expectedSenderId: number;
  readonly frameUrl: string | null;
  readonly expectedFrameUrl: string;
  readonly topLevelFrame: boolean;
  readonly sameSession: boolean;
}

export function assertDesktopIpcEvent(facts: DesktopIpcEventFacts): void {
  if (
    facts.senderId !== facts.expectedSenderId || facts.frameUrl !== facts.expectedFrameUrl ||
    !facts.topLevelFrame || !facts.sameSession
  ) throw new Error("SENDER_REJECTED");
}
