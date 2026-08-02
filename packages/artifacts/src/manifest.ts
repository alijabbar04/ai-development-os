import { validation, type ArtifactId, type TaskRunId } from "@ai-dev-os/domain";
import { parseArtifactDescriptor, type ArtifactDescriptor, type ArtifactRole } from "./artifact.js";

const {
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSchemaVersion,
  ensureString,
  ensureTimestamp,
  fail,
} = validation;

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const MAX_MANIFEST_ARTIFACTS = 1_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The complete set of artifacts one task run produced or consumed.
 * Artifact ids are unique within a manifest; parent references may point
 * at artifacts outside the manifest (earlier task runs).
 */
export interface ArtifactManifest {
  readonly schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly taskRunId: TaskRunId | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly createdAt: string;
}

export function parseArtifactManifest(value: unknown, path = "artifactManifest"): ArtifactManifest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["schemaVersion", "manifestId", "taskRunId", "artifacts", "createdAt"], path);
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    ARTIFACT_MANIFEST_SCHEMA_VERSION,
  );

  const artifactsValue = record["artifacts"];
  const artifactList: readonly unknown[] =
    Array.isArray(artifactsValue) && artifactsValue.length <= MAX_MANIFEST_ARTIFACTS
      ? (artifactsValue as readonly unknown[])
      : fail(
          `${path}.artifacts`,
          "bad_artifacts",
          `must be an array of at most ${MAX_MANIFEST_ARTIFACTS} artifact descriptors.`,
        );

  const seen = new Set<string>();
  const artifacts = artifactList.map((entry, index) => {
    const descriptor = parseArtifactDescriptor(entry, `${path}.artifacts[${index}]`);
    if (seen.has(descriptor.id)) {
      fail(`${path}.artifacts[${index}].id`, "duplicate_artifact", "duplicates another artifact id.");
    }
    seen.add(descriptor.id);
    return descriptor;
  });

  return Object.freeze({
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    manifestId: ensureString(record["manifestId"], `${path}.manifestId`, {
      maxLength: 128,
      pattern: ID_PATTERN,
      patternName: "manifest identifier",
    }),
    taskRunId: ensureNullable(record["taskRunId"], (id) =>
      ensureString(id, `${path}.taskRunId`, {
        maxLength: 128,
        pattern: ID_PATTERN,
        patternName: "TaskRunId",
      }) as TaskRunId,
    ),
    artifacts: Object.freeze(artifacts),
    createdAt: ensureTimestamp(record["createdAt"], `${path}.createdAt`),
  });
}

export function createArtifactManifest(
  input: Omit<ArtifactManifest, "schemaVersion">,
): ArtifactManifest {
  return parseArtifactManifest({ schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION, ...input });
}

export function findArtifactById(
  manifest: ArtifactManifest,
  artifactId: ArtifactId,
): ArtifactDescriptor | undefined {
  return manifest.artifacts.find((artifact) => artifact.id === artifactId);
}

export function listArtifactsByRole(
  manifest: ArtifactManifest,
  role: ArtifactRole,
): readonly ArtifactDescriptor[] {
  return Object.freeze(manifest.artifacts.filter((artifact) => artifact.role === role));
}
