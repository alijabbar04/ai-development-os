import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-dev-os/domain";
import {
  createArtifactDescriptor,
  createArtifactManifest,
  findArtifactById,
  isInputArtifact,
  isLogArtifact,
  isOutputArtifact,
  isPatchArtifact,
  isTestResultArtifact,
  listArtifactsByRole,
  parseArtifactDescriptor,
  parseArtifactManifest,
  parseArtifactProducer,
  parseArtifactProvenance,
  type ArtifactDescriptor,
  type ArtifactProvenance,
} from "../src/index.js";

const PROVENANCE: ArtifactProvenance = parseArtifactProvenance({
  producedBy: { type: "model", providerId: "provider-a", modelId: "model-x" },
  runId: "run-1",
  taskId: "task-1",
  taskRunId: "attempt-1",
  traceId: "trace-1",
});

const DESCRIPTOR_INPUT = {
  id: "artifact-1" as ArtifactDescriptor["id"],
  displayName: "diff for task-1",
  kind: "patch",
  role: "output",
  mediaType: "text/x-diff",
  sizeBytes: 2_048,
  digest: { algorithm: "sha-256", hex: "a".repeat(64) },
  classification: "proprietary-source",
  location: { type: "content-addressed", store: "local" },
  provenance: PROVENANCE,
  parents: ["artifact-0"],
  createdAt: "2026-08-02T10:00:00.000Z",
} as const;

function descriptor(overrides: Record<string, unknown> = {}): ArtifactDescriptor {
  return parseArtifactDescriptor({ schemaVersion: 1, ...DESCRIPTOR_INPUT, ...overrides });
}

describe("ArtifactProducer and provenance", () => {
  it("parses every producer variant", () => {
    expect(parseArtifactProducer({ type: "user" })).toEqual({ type: "user" });
    expect(parseArtifactProducer({ type: "agent", agentId: "agent-1" })).toEqual({
      type: "agent",
      agentId: "agent-1",
    });
    expect(parseArtifactProducer({ type: "system", component: "integrator" })).toEqual({
      type: "system",
      component: "integrator",
    });
    expect(
      parseArtifactProducer({ type: "model", providerId: "p", modelId: "m" }).type,
    ).toBe("model");
  });

  it("rejects mixed or incomplete producers", () => {
    expect(() => parseArtifactProducer({ type: "user", agentId: "a" })).toThrow(ValidationError);
    expect(() => parseArtifactProducer({ type: "model", providerId: "p" })).toThrow(
      ValidationError,
    );
    expect(() => parseArtifactProducer({ type: "robot" })).toThrow(ValidationError);
  });

  it("normalizes optional provenance references to null", () => {
    const minimal = parseArtifactProvenance({
      producedBy: { type: "user" },
      runId: null,
      taskId: undefined,
      taskRunId: null,
      traceId: null,
    });
    expect(minimal.taskId).toBeNull();
    expect(Object.isFrozen(minimal)).toBe(true);
  });
});

describe("ArtifactDescriptor", () => {
  it("creates an immutable descriptor with stable fields", () => {
    const artifact = createArtifactDescriptor(DESCRIPTOR_INPUT);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.displayName).toBe("diff for task-1");
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.parents)).toBe(true);
  });

  it("round-trips through JSON", () => {
    const artifact = descriptor();
    expect(parseArtifactDescriptor(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it("rejects unsafe display names", () => {
    const hostile = [
      "../escape",
      "name/with/slash",
      "name\\with\\backslash",
      "name:with:colon",
      "name*wildcard",
      "name?query",
      "name<tag>",
      "name|pipe",
      "control\tchar",
      ".leading-dot",
      " leading-space",
      "trailing-space ",
      "trailing-dot.",
      "a".repeat(121),
      "",
    ];
    for (const displayName of hostile) {
      expect(() => descriptor({ displayName })).toThrow(ValidationError);
    }
    expect(descriptor({ displayName: "plain name (v2) - final" }).displayName).toBe(
      "plain name (v2) - final",
    );
  });

  it("rejects invalid media types, sizes, classifications, and versions", () => {
    expect(() => descriptor({ mediaType: "TEXT/PLAIN" })).toThrow(ValidationError);
    expect(() => descriptor({ mediaType: "no-slash" })).toThrow(ValidationError);
    expect(() => descriptor({ sizeBytes: -1 })).toThrow(ValidationError);
    expect(() => descriptor({ sizeBytes: 1.5 })).toThrow(ValidationError);
    expect(() => descriptor({ classification: "mystery" })).toThrow(ValidationError);
    expect(() => descriptor({ schemaVersion: 2 })).toThrow(ValidationError);
    expect(() => descriptor({ extraField: true })).toThrow(ValidationError);
  });

  it("rejects self-referencing and duplicate parents", () => {
    expect(() => descriptor({ parents: ["artifact-1"] })).toThrow(ValidationError);
    expect(() => descriptor({ parents: ["p1", "p1"] })).toThrow(ValidationError);
    expect(() => descriptor({ parents: Array.from({ length: 65 }, (_, i) => `p${i}`) })).toThrow(
      ValidationError,
    );
  });

  it("narrows typed artifact aliases through guards", () => {
    const patch = descriptor();
    expect(isPatchArtifact(patch)).toBe(true);
    expect(isOutputArtifact(patch)).toBe(true);
    expect(isInputArtifact(patch)).toBe(false);

    const log = descriptor({ kind: "log", role: "diagnostic", mediaType: "text/plain" });
    expect(isLogArtifact(log)).toBe(true);
    expect(isTestResultArtifact(log)).toBe(false);

    const testResult = descriptor({ kind: "test-result", mediaType: "application/json" });
    expect(isTestResultArtifact(testResult)).toBe(true);

    const input = descriptor({ role: "input", kind: "source-file" });
    expect(isInputArtifact(input)).toBe(true);
  });
});

describe("ArtifactManifest", () => {
  const MANIFEST_INPUT = {
    manifestId: "manifest-1",
    taskRunId: "attempt-1" as never,
    artifacts: [descriptor(), descriptor({ id: "artifact-2", role: "input", kind: "source-file" })],
    createdAt: "2026-08-02T10:05:00.000Z",
  };

  it("creates and round-trips a manifest", () => {
    const manifest = createArtifactManifest(MANIFEST_INPUT);
    expect(manifest.artifacts).toHaveLength(2);
    expect(Object.isFrozen(manifest.artifacts)).toBe(true);
    expect(parseArtifactManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("rejects duplicate artifact ids and oversized manifests", () => {
    expect(() =>
      createArtifactManifest({ ...MANIFEST_INPUT, artifacts: [descriptor(), descriptor()] }),
    ).toThrow(ValidationError);
    expect(() =>
      createArtifactManifest({ ...MANIFEST_INPUT, artifacts: "none" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      parseArtifactManifest({ schemaVersion: 9, ...MANIFEST_INPUT }),
    ).toThrow(ValidationError);
  });

  it("normalizes a missing taskRunId and supports lookups", () => {
    const manifest = createArtifactManifest({ ...MANIFEST_INPUT, taskRunId: null });
    expect(manifest.taskRunId).toBeNull();

    const found = findArtifactById(manifest, manifest.artifacts[1]!.id);
    expect(found?.role).toBe("input");
    expect(findArtifactById(manifest, "ghost" as never)).toBeUndefined();

    expect(listArtifactsByRole(manifest, "output")).toHaveLength(1);
    expect(listArtifactsByRole(manifest, "diagnostic")).toHaveLength(0);
  });
});
