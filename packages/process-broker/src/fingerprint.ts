/**
 * Canonical fingerprints.
 *
 * Every fingerprint is a SHA-256 digest over canonical JSON, so key insertion
 * order never changes the result and two structurally identical subjects
 * always produce the same digest. These digests are what bind a policy
 * decision and an approval to the exact action that was authorized.
 */

import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value), "utf8").digest("hex");
}

/**
 * The normalized subject of a command execution.
 *
 * This is the Stage 8 side of the Stage 6 policy contract: the policy broker
 * validates only that a subject digest is 64 hexadecimal characters, and this
 * function decides what those characters mean. Changing the executable, any
 * argument, the working directory, the workspace, the network policy, or a
 * quota produces a different digest, which invalidates any approval that was
 * granted for the previous subject.
 */
export interface CommandSubject {
  readonly toolId: string;
  readonly executableDigest: string | null;
  readonly immutableReference: string | null;
  readonly arguments: readonly string[];
  readonly workingDirectory: string | null;
  readonly workspaceId: string;
  readonly snapshotId: string | null;
  readonly networkMode: string;
  readonly egressDomains: readonly string[];
  readonly quotas: Readonly<Record<string, number | null>>;
  readonly environmentNames: readonly string[];
  readonly stdinDigest: string | null;
}

export function commandSubjectDigest(subject: CommandSubject): string {
  return fingerprintOf({
    kind: "command-execution",
    version: 1,
    toolId: subject.toolId,
    executableDigest: subject.executableDigest,
    immutableReference: subject.immutableReference,
    arguments: [...subject.arguments],
    workingDirectory: subject.workingDirectory,
    workspaceId: subject.workspaceId,
    snapshotId: subject.snapshotId,
    networkMode: subject.networkMode,
    egressDomains: [...subject.egressDomains].sort(),
    quotas: subject.quotas,
    environmentNames: [...subject.environmentNames].sort(),
    stdinDigest: subject.stdinDigest,
  });
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
