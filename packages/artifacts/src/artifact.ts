import {
  parseArtifactId,
  parseDataClassification,
  validation,
  type AgentId,
  type ArtifactId,
  type DataClassification,
  type ModelId,
  type ProviderId,
  type RunId,
  type TaskId,
  type TaskRunId,
  type TraceId,
} from "@ai-dev-os/domain";
import { parseArtifactLocation, parseArtifactDigest, type ArtifactDigest, type ArtifactLocation } from "./location.js";

const {
  ensureArray,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Content category of the artifact payload. */
export const ARTIFACT_KINDS = Object.freeze([
  "binary",
  "document",
  "log",
  "patch",
  "source-file",
  "structured-data",
  "test-result",
] as const);

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Logical role the artifact plays in a task's dataflow. */
export const ARTIFACT_ROLES = Object.freeze(["input", "output", "intermediate", "diagnostic"] as const);

export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const MAX_ARTIFACT_BYTES = 1_000_000_000_000;
export const MAX_PARENT_ARTIFACTS = 64;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Display names exclude control characters, path separators, and the
// characters Windows forbids in file names, so they are safe to render
// and can never be interpreted as a path.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const SAFE_DISPLAY_NAME_PATTERN = /^(?![ .])[^\u0000-\u001f\u007f/\\:*?"<>|]{1,120}$(?<![ .])/;

export type ArtifactProducer =
  | {
      readonly type: "model";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly type: "agent";
      readonly agentId: AgentId;
    }
  | { readonly type: "user" }
  | {
      readonly type: "system";
      readonly component: string;
    };

export const ARTIFACT_PRODUCER_TYPES = Object.freeze(["model", "agent", "user", "system"] as const);

function parseId<T extends string>(value: unknown, path: string, label: string): T {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID_PATTERN,
    patternName: label,
  }) as T;
}

export function parseArtifactProducer(value: unknown, path = "producer"): ArtifactProducer {
  const record = ensureRecord(value, path);
  const type = ensureEnum(record["type"], `${path}.type`, ARTIFACT_PRODUCER_TYPES);

  switch (type) {
    case "model":
      ensureExactKeys(record, ["type", "providerId", "modelId"], path);
      return Object.freeze({
        type,
        providerId: parseId<ProviderId>(record["providerId"], `${path}.providerId`, "ProviderId"),
        modelId: parseId<ModelId>(record["modelId"], `${path}.modelId`, "ModelId"),
      });
    case "agent":
      ensureExactKeys(record, ["type", "agentId"], path);
      return Object.freeze({
        type,
        agentId: parseId<AgentId>(record["agentId"], `${path}.agentId`, "AgentId"),
      });
    case "user":
      ensureExactKeys(record, ["type"], path);
      return Object.freeze({ type });
    case "system":
      ensureExactKeys(record, ["type", "component"], path);
      return Object.freeze({
        type,
        component: ensureString(record["component"], `${path}.component`, {
          maxLength: 128,
          pattern: ID_PATTERN,
          patternName: "component name",
        }),
      });
  }
}

/** Who and what produced an artifact, with correlation identifiers. */
export interface ArtifactProvenance {
  readonly producedBy: ArtifactProducer;
  readonly runId: RunId | null;
  readonly taskId: TaskId | null;
  readonly taskRunId: TaskRunId | null;
  readonly traceId: TraceId | null;
}

export function parseArtifactProvenance(value: unknown, path = "provenance"): ArtifactProvenance {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["producedBy", "runId", "taskId", "taskRunId", "traceId"], path);
  return Object.freeze({
    producedBy: parseArtifactProducer(record["producedBy"], `${path}.producedBy`),
    runId: ensureNullable(record["runId"], (id) => parseId<RunId>(id, `${path}.runId`, "RunId")),
    taskId: ensureNullable(record["taskId"], (id) => parseId<TaskId>(id, `${path}.taskId`, "TaskId")),
    taskRunId: ensureNullable(record["taskRunId"], (id) =>
      parseId<TaskRunId>(id, `${path}.taskRunId`, "TaskRunId"),
    ),
    traceId: ensureNullable(record["traceId"], (id) =>
      parseId<TraceId>(id, `${path}.traceId`, "TraceId"),
    ),
  });
}

/**
 * Immutable metadata describing one artifact. There is deliberately no
 * free-form metadata map: unrestricted paths and raw contents must never
 * ride along inside descriptor metadata.
 */
export interface ArtifactDescriptor {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly id: ArtifactId;
  readonly displayName: string;
  readonly kind: ArtifactKind;
  readonly role: ArtifactRole;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: ArtifactDigest;
  readonly classification: DataClassification;
  readonly location: ArtifactLocation;
  readonly provenance: ArtifactProvenance;
  readonly parents: readonly ArtifactId[];
  readonly createdAt: string;
}

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "id",
  "displayName",
  "kind",
  "role",
  "mediaType",
  "sizeBytes",
  "digest",
  "classification",
  "location",
  "provenance",
  "parents",
  "createdAt",
] as const;

export function parseArtifactDescriptor(
  value: unknown,
  path = "artifactDescriptor",
): ArtifactDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, DESCRIPTOR_KEYS, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, ARTIFACT_SCHEMA_VERSION);

  const id = parseArtifactId(record["id"], `${path}.id`);
  const parentsRaw = ensureArray(record["parents"], `${path}.parents`, MAX_PARENT_ARTIFACTS);
  const parents: ArtifactId[] = [];
  const seenParents = new Set<string>();
  parentsRaw.forEach((parent, index) => {
    const parentId = parseArtifactId(parent, `${path}.parents[${index}]`);
    if (parentId === id) {
      fail(`${path}.parents[${index}]`, "self_parent", "cannot reference the artifact itself.");
    }
    if (seenParents.has(parentId)) {
      fail(`${path}.parents[${index}]`, "duplicate_parent", "duplicates another parent reference.");
    }
    seenParents.add(parentId);
    parents.push(parentId);
  });

  return Object.freeze({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id,
    displayName: ensureString(record["displayName"], `${path}.displayName`, {
      maxLength: 120,
      pattern: SAFE_DISPLAY_NAME_PATTERN,
      patternName: "safe display name",
    }),
    kind: ensureEnum(record["kind"], `${path}.kind`, ARTIFACT_KINDS),
    role: ensureEnum(record["role"], `${path}.role`, ARTIFACT_ROLES),
    mediaType: ensureString(record["mediaType"], `${path}.mediaType`, {
      maxLength: 128,
      pattern: MEDIA_TYPE_PATTERN,
      patternName: "media type",
    }),
    sizeBytes: ensureSafeInteger(record["sizeBytes"], `${path}.sizeBytes`, 0, MAX_ARTIFACT_BYTES),
    digest: parseArtifactDigest(record["digest"], `${path}.digest`),
    classification: parseDataClassification(record["classification"], `${path}.classification`),
    location: parseArtifactLocation(record["location"], `${path}.location`),
    provenance: parseArtifactProvenance(record["provenance"], `${path}.provenance`),
    parents: Object.freeze(parents),
    createdAt: ensureTimestamp(record["createdAt"], `${path}.createdAt`),
  });
}

export function createArtifactDescriptor(
  input: Omit<ArtifactDescriptor, "schemaVersion">,
): ArtifactDescriptor {
  return parseArtifactDescriptor({ schemaVersion: ARTIFACT_SCHEMA_VERSION, ...input });
}

export type InputArtifact = ArtifactDescriptor & { readonly role: "input" };
export type OutputArtifact = ArtifactDescriptor & { readonly role: "output" };
export type PatchArtifact = ArtifactDescriptor & { readonly kind: "patch" };
export type TestResultArtifact = ArtifactDescriptor & { readonly kind: "test-result" };
export type LogArtifact = ArtifactDescriptor & { readonly kind: "log" };

export function isInputArtifact(artifact: ArtifactDescriptor): artifact is InputArtifact {
  return artifact.role === "input";
}

export function isOutputArtifact(artifact: ArtifactDescriptor): artifact is OutputArtifact {
  return artifact.role === "output";
}

export function isPatchArtifact(artifact: ArtifactDescriptor): artifact is PatchArtifact {
  return artifact.kind === "patch";
}

export function isTestResultArtifact(
  artifact: ArtifactDescriptor,
): artifact is TestResultArtifact {
  return artifact.kind === "test-result";
}

export function isLogArtifact(artifact: ArtifactDescriptor): artifact is LogArtifact {
  return artifact.kind === "log";
}
