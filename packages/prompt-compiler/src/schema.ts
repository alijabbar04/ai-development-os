import type { JsonValue } from "@ai-dev-os/domain";

export const THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION = 1 as const;
export const MAX_PROPOSAL_TASKS = 32;
export const MAX_PROPOSAL_LIST_ITEMS = 64;
export const MAX_PROPOSAL_DEPENDENCIES = 32;
export const MAX_PROPOSAL_TEXT = 4_000;

const boundedText = Object.freeze({ type: "string", minLength: 1, maxLength: MAX_PROPOSAL_TEXT });
const boundedTextArray = Object.freeze({
  type: "array",
  maxItems: MAX_PROPOSAL_LIST_ITEMS,
  items: boundedText
});
const evidenceReference = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["identity", "digest"],
  properties: {
    identity: { type: "string", minLength: 1, maxLength: 256 },
    digest: { type: "string", pattern: "^[0-9a-f]{64}$" }
  }
});
const proposedTask = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "proposalId",
    "kind",
    "title",
    "description",
    "dependencies",
    "acceptanceCriteria",
    "evidence",
    "unsupportedAssumptions",
    "complexity",
    "reasoning",
    "capabilities",
    "editScope",
    "risk",
    "classification"
  ],
  properties: {
    proposalId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"
    },
    kind: {
      type: "string",
      enum: [
        "plan",
        "architecture",
        "implement",
        "refactor",
        "debug",
        "review",
        "test",
        "document",
        "shell",
        "explain",
        "transform"
      ]
    },
    title: { type: "string", minLength: 1, maxLength: 240 },
    description: boundedText,
    dependencies: {
      type: "array",
      maxItems: MAX_PROPOSAL_DEPENDENCIES,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64 }
    },
    acceptanceCriteria: boundedTextArray,
    evidence: {
      type: "array",
      maxItems: MAX_PROPOSAL_LIST_ITEMS,
      items: evidenceReference
    },
    unsupportedAssumptions: boundedTextArray,
    complexity: { type: "integer", minimum: 1, maximum: 5 },
    reasoning: { type: "string", enum: ["low", "medium", "high", "extreme"] },
    capabilities: {
      type: "array",
      maxItems: 9,
      uniqueItems: true,
      items: {
        type: "string",
        enum: [
          "reasoning",
          "repository-read",
          "code-edit",
          "shell",
          "testing",
          "documentation",
          "vision",
          "structured-output",
          "tool-use"
        ]
      }
    },
    editScope: {
      type: "string",
      enum: ["none", "single-file", "multi-file", "cross-package"]
    },
    risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
    classification: {
      type: "string",
      enum: ["public", "internal", "proprietary-source", "personal", "secret"]
    }
  }
});

/** Fixed strict schema supplied through `InferenceRequest.structuredOutput`. */
export const THINKER_PROPOSAL_JSON_SCHEMA: JsonValue = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai-dev-os.invalid/schemas/thinker-proposal-v1.json",
  title: "AI Development OS authority-free thinker proposal",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "status",
    "objective",
    "assumptions",
    "risks",
    "openQuestions",
    "completionCriteria",
    "tasks"
  ],
  properties: {
    schemaVersion: { const: THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION },
    status: { type: "string", enum: ["viable", "blocked", "clarification-required"] },
    objective: boundedText,
    assumptions: boundedTextArray,
    risks: boundedTextArray,
    openQuestions: boundedTextArray,
    completionCriteria: boundedTextArray,
    tasks: { type: "array", maxItems: MAX_PROPOSAL_TASKS, items: proposedTask }
  }
});
