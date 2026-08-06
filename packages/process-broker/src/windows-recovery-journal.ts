/**
 * Windows production recovery-record format (ADR 0017 section 5).
 *
 * Package-private, like `trusted-evidence.ts`: it is not reachable through the
 * package export map. First-party code imports it by relative path.
 *
 * This module is a **reader and validator only**. There is no writer, so
 * nothing here can create a journal, a directory, or any other host state.
 * Every function is pure over byte buffers.
 *
 * The Windows supervisor implements the identical format in reviewed C#. The
 * two implementations are cross-checked by fixed conformance vectors: the
 * canonical bytes of a fixed record and the digest of a fixed journal are
 * pinned on both sides, so a change to either implementation that is not
 * mirrored fails a test rather than silently producing a journal one side
 * cannot read.
 *
 * The control plane needs this because removal must be refused while any
 * recoverable operation still references a bundle version (ADR 0017
 * section 7), and "recoverable" is a property of the journal.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  WINDOWS_ARTIFACT_COMPONENTS,
  WINDOWS_PRODUCTION_PROTOCOL_VERSION,
  type WindowsArtifactComponent,
} from "./windows-artifact.js";

export const WINDOWS_RECOVERY_RECORD_SCHEMA_VERSION = 1 as const;
export const WINDOWS_OPERATION_TOKEN_HEX_LENGTH = 32;
export const WINDOWS_RECOVERY_DIGEST_BYTES = 32;
export const WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES = 4;
export const MAX_WINDOWS_RECOVERY_RECORD_BYTES = 4_096;
export const MAX_WINDOWS_RECOVERY_RECORDS = 16;

const DERIVATION_PREFIX = "ai-dev-os/stage-17/windows-production/v1/";
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const BUNDLE_VERSION_PATTERN =
  /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9]{1,16}(?:\.[a-z0-9]{1,16})*)?$/;

/** The linear, monotonic operation phases. Index is the ordering. */
export const WINDOWS_OPERATION_PHASES = Object.freeze([
  "request-accepted",
  "setup-complete",
  "target-created",
  "target-suspended",
  "target-ready",
  "target-exited",
  "cleanup-complete",
] as const);
export type WindowsOperationPhase = (typeof WINDOWS_OPERATION_PHASES)[number];

export const WINDOWS_RECOVERY_REFUSALS = Object.freeze([
  "recovery-journal-overlong",
  "recovery-record-digest-mismatch",
  "recovery-record-path-mismatch",
  "recovery-record-schema-invalid",
  "recovery-record-sequence-invalid",
  "recovery-record-token-mismatch",
  "state-out-of-order",
  "token-malformed",
] as const);
export type WindowsRecoveryRefusal = (typeof WINDOWS_RECOVERY_REFUSALS)[number];

export interface WindowsRecoveryRecord {
  readonly component: WindowsArtifactComponent;
  readonly operationToken: string;
  readonly phase: WindowsOperationPhase;
  readonly sequence: number;
  readonly bundleVersion: string;
}

export interface WindowsRecoveryJournal {
  readonly records: readonly WindowsRecoveryRecord[];
  readonly truncatedTrailingRecordDiscarded: boolean;
  readonly lastPhase: WindowsOperationPhase | null;
  readonly requiresRecovery: boolean;
}

export type WindowsRecoveryJournalResult =
  | { readonly ok: true; readonly journal: WindowsRecoveryJournal }
  | { readonly ok: false; readonly code: WindowsRecoveryRefusal };

export function isWindowsOperationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * Derives a fixed-width label for one purpose. The purpose set is closed and
 * a different token always derives a different, non-existent name, which is
 * what makes a substituted journal harmless.
 */
export function deriveWindowsOperationName(purpose: string, token: string): string {
  return createHash("sha256")
    .update(`${DERIVATION_PREFIX}${purpose}/${token}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function windowsProfileName(token: string): string {
  return `AiDevOs.S17.${deriveWindowsOperationName("appcontainer-profile", token)}`;
}

export function windowsStagingRootLeaf(token: string): string {
  return `aidevos-s17-${deriveWindowsOperationName("staging-root", token)}`;
}

export function windowsJournalFileName(token: string): string {
  return `${token}.journal`;
}

export function windowsStagedFileNames(token: string): readonly string[] {
  return Object.freeze([
    `req-${deriveWindowsOperationName("request-file", token)}.bin`,
    `res-${deriveWindowsOperationName("response-file", token)}.bin`,
  ]);
}

/** The canonical bytes a record digests over. */
export function canonicalWindowsRecoveryRecord(record: WindowsRecoveryRecord): string {
  return toCanonicalJson({
    bundleVersion: record.bundleVersion,
    component: record.component,
    operationToken: record.operationToken,
    phase: record.phase,
    profileName: windowsProfileName(record.operationToken),
    recordVersion: WINDOWS_PRODUCTION_PROTOCOL_VERSION,
    schemaVersion: WINDOWS_RECOVERY_RECORD_SCHEMA_VERSION,
    sequence: record.sequence,
    stagedFileNames: [...windowsStagedFileNames(record.operationToken)],
    stagingRootLeaf: windowsStagingRootLeaf(record.operationToken),
  });
}

/**
 * The record digest covers the length prefix as well as the canonical bytes,
 * so a record cannot be re-framed under a different declared length and still
 * verify.
 */
export function windowsRecoveryRecordDigest(canonical: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES + canonical.length);
  new DataView(prefixed.buffer).setUint32(0, canonical.length, true);
  prefixed.set(canonical, WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES);
  return new Uint8Array(createHash("sha256").update(prefixed).digest());
}

/** Frames a record the way the supervisor writes it. Used only by tests. */
export function frameWindowsRecoveryRecord(record: WindowsRecoveryRecord): Uint8Array {
  const canonical = new TextEncoder().encode(canonicalWindowsRecoveryRecord(record));
  const digest = windowsRecoveryRecordDigest(canonical);
  const framed = new Uint8Array(
    WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES + canonical.length + digest.length,
  );
  new DataView(framed.buffer).setUint32(0, canonical.length, true);
  framed.set(canonical, WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES);
  framed.set(digest, WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES + canonical.length);
  return framed;
}

function digestsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

const RECORD_KEYS = [
  "bundleVersion",
  "component",
  "operationToken",
  "phase",
  "profileName",
  "recordVersion",
  "schemaVersion",
  "sequence",
  "stagedFileNames",
  "stagingRootLeaf",
];

function parseRecord(
  canonical: Uint8Array,
  expectedToken: string,
): { readonly ok: true; readonly record: WindowsRecoveryRecord } | {
  readonly ok: false;
  readonly code: WindowsRecoveryRefusal;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonical)) as unknown;
  } catch {
    return { ok: false, code: "recovery-record-schema-invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "recovery-record-schema-invalid" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    return { ok: false, code: "recovery-record-schema-invalid" };
  }
  if (
    record["schemaVersion"] !== WINDOWS_RECOVERY_RECORD_SCHEMA_VERSION ||
    record["recordVersion"] !== WINDOWS_PRODUCTION_PROTOCOL_VERSION
  ) {
    return { ok: false, code: "recovery-record-schema-invalid" };
  }
  const component = record["component"];
  const phase = record["phase"];
  const sequence = record["sequence"];
  const bundleVersion = record["bundleVersion"];
  if (
    typeof component !== "string" ||
    !(WINDOWS_ARTIFACT_COMPONENTS as readonly string[]).includes(component) ||
    typeof phase !== "string" ||
    !(WINDOWS_OPERATION_PHASES as readonly string[]).includes(phase) ||
    typeof bundleVersion !== "string" ||
    !BUNDLE_VERSION_PATTERN.test(bundleVersion)
  ) {
    return { ok: false, code: "recovery-record-schema-invalid" };
  }
  if (record["operationToken"] !== expectedToken) {
    return { ok: false, code: "recovery-record-token-mismatch" };
  }
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > MAX_WINDOWS_RECOVERY_RECORDS
  ) {
    return { ok: false, code: "recovery-record-sequence-invalid" };
  }

  // Paths in the journal are never trusted: they are recomputed from the token
  // and compared. A hostile journal can at most name a different token, and a
  // different token derives a different, non-existent path.
  const stagedFileNames = record["stagedFileNames"];
  const expectedStaged = windowsStagedFileNames(expectedToken);
  if (
    record["profileName"] !== windowsProfileName(expectedToken) ||
    record["stagingRootLeaf"] !== windowsStagingRootLeaf(expectedToken) ||
    !Array.isArray(stagedFileNames) ||
    stagedFileNames.length !== expectedStaged.length ||
    stagedFileNames.some((name, index) => name !== expectedStaged[index])
  ) {
    return { ok: false, code: "recovery-record-path-mismatch" };
  }

  return {
    ok: true,
    record: Object.freeze({
      component: component as WindowsArtifactComponent,
      operationToken: expectedToken,
      phase: phase as WindowsOperationPhase,
      sequence,
      bundleVersion,
    }),
  };
}

/**
 * Reads a complete journal. A truncated trailing record is detected and
 * discarded; a complete record whose digest, token, derived paths, sequence, or
 * phase ordering is wrong is a refusal, not a discard.
 */
export function readWindowsRecoveryJournal(
  buffer: Uint8Array,
  expectedToken: string,
): WindowsRecoveryJournalResult {
  if (!isWindowsOperationToken(expectedToken)) {
    return { ok: false, code: "token-malformed" };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const records: WindowsRecoveryRecord[] = [];
  let truncated = false;
  let offset = 0;
  let previousSequence = 0;
  let previousPhase = -1;

  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining < WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES) {
      truncated = true;
      break;
    }
    const declared = view.getUint32(offset, true);
    if (declared === 0 || declared > MAX_WINDOWS_RECOVERY_RECORD_BYTES) {
      return { ok: false, code: "recovery-record-schema-invalid" };
    }
    const needed = WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES + declared + WINDOWS_RECOVERY_DIGEST_BYTES;
    if (remaining < needed) {
      truncated = true;
      break;
    }
    const start = offset + WINDOWS_RECOVERY_LENGTH_PREFIX_BYTES;
    const canonical = buffer.subarray(start, start + declared);
    const storedDigest = buffer.subarray(start + declared, start + declared + WINDOWS_RECOVERY_DIGEST_BYTES);
    if (!digestsEqual(windowsRecoveryRecordDigest(canonical), storedDigest)) {
      return { ok: false, code: "recovery-record-digest-mismatch" };
    }

    const parsed = parseRecord(canonical, expectedToken);
    if (!parsed.ok) {
      return { ok: false, code: parsed.code };
    }
    if (parsed.record.sequence <= previousSequence) {
      return { ok: false, code: "recovery-record-sequence-invalid" };
    }
    const phaseIndex = WINDOWS_OPERATION_PHASES.indexOf(parsed.record.phase);
    if (phaseIndex <= previousPhase) {
      return { ok: false, code: "state-out-of-order" };
    }
    previousSequence = parsed.record.sequence;
    previousPhase = phaseIndex;
    records.push(parsed.record);
    if (records.length > MAX_WINDOWS_RECOVERY_RECORDS) {
      return { ok: false, code: "recovery-journal-overlong" };
    }
    offset += needed;
  }

  const lastPhase = records.length === 0 ? null : (records[records.length - 1]?.phase ?? null);
  return {
    ok: true,
    journal: Object.freeze({
      records: Object.freeze(records),
      truncatedTrailingRecordDiscarded: truncated,
      lastPhase,
      requiresRecovery: lastPhase !== "cleanup-complete",
    }),
  };
}

/**
 * An operation whose token is in the live set belongs to a running operation,
 * so an old restored journal cannot target it. A journal that already reached
 * `cleanup-complete` is stale evidence of a finished operation and must cause
 * no cleanup action at all.
 */
export function isWindowsRecoveryJournalActionable(
  operationToken: string,
  journal: WindowsRecoveryJournal,
  liveTokens: readonly string[],
): boolean {
  if (!isWindowsOperationToken(operationToken)) return false;
  if (!journal.requiresRecovery) return false;
  return !liveTokens.includes(operationToken);
}

/** The bundle versions a journal set still pins, for removal gating. */
export function windowsRecoverableBundleVersions(
  journals: readonly { readonly token: string; readonly journal: WindowsRecoveryJournal }[],
  liveTokens: readonly string[],
): readonly string[] {
  const versions = new Set<string>();
  for (const entry of journals) {
    if (!isWindowsRecoveryJournalActionable(entry.token, entry.journal, liveTokens)) continue;
    for (const record of entry.journal.records) {
      versions.add(record.bundleVersion);
    }
  }
  return Object.freeze([...versions].sort());
}
