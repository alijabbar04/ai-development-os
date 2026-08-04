import { createHash } from "node:crypto";
import { canonicalizeJson, toCanonicalJson, type JsonValue } from "@ai-dev-os/domain";
import type { TelemetryObservation } from "./types.js";

export function telemetrySnapshotFingerprint(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value, "telemetry fingerprint input")).digest("hex");
}

export function canonicalTelemetryValue<T>(value: T): T {
  return canonicalizeJson(value, "telemetry value") as JsonValue as T;
}

export function observationPayloadFingerprint(
  observation: Omit<TelemetryObservation, "canonicalPayloadFingerprint"> | TelemetryObservation,
): string {
  const copy = { ...observation } as Record<string, unknown>;
  delete copy["canonicalPayloadFingerprint"];
  return telemetrySnapshotFingerprint(copy);
}

export function observationIdempotencyFingerprint(
  observation: Omit<TelemetryObservation, "canonicalPayloadFingerprint"> | TelemetryObservation,
): string {
  const copy = { ...observation } as Record<string, unknown>;
  delete copy["canonicalPayloadFingerprint"];
  // Receipt time is still covered by the canonical payload fingerprint, but
  // store-assigned metadata cannot turn a retry into different caller input.
  delete copy["ingestedAt"];
  return telemetrySnapshotFingerprint(copy);
}
