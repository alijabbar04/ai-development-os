import {
  REASONING_DEMANDS,
  TASK_KINDS,
  validation,
  type ReasoningDemand,
  type TaskKind
} from "@ai-dev-os/domain";
import { digest, HEX_64, SAFE_KIND, compareText } from "./shared.js";

const {
  ensureArray,
  ensureEnum,
  ensureEnumArray,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  fail
} = validation;

export const CLASSIFIER_HINT_SCHEMA_VERSION = 1 as const;
export const CLASSIFIER_CODING_REQUIREMENTS = Object.freeze(["none", "read", "edit"] as const);
export type ClassifierCodingRequirement = (typeof CLASSIFIER_CODING_REQUIREMENTS)[number];

export interface ClassifierHint {
  readonly schemaVersion: typeof CLASSIFIER_HINT_SCHEMA_VERSION;
  readonly taskKind: TaskKind;
  readonly complexity: number;
  readonly reasoning: ReasoningDemand;
  readonly codingRequirement: ClassifierCodingRequirement;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly fingerprint: string;
}

export function classifierHintFingerprint(value: Omit<ClassifierHint, "fingerprint">): string {
  return digest(value);
}

export function parseClassifierHint(value: unknown, path = "classifierHint"): ClassifierHint {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "taskKind",
      "complexity",
      "reasoning",
      "codingRequirement",
      "confidence",
      "reasonCodes",
      "fingerprint"
    ],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, CLASSIFIER_HINT_SCHEMA_VERSION);
  const reasonCodes = ensureArray(record["reasonCodes"], `${path}.reasonCodes`, 16)
    .map((item, index) =>
      ensureString(item, `${path}.reasonCodes[${index}]`, {
        minLength: 1,
        maxLength: 64,
        pattern: SAFE_KIND,
        patternName: "reason code"
      })
    )
    .sort(compareText);
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    fail(`${path}.reasonCodes`, "duplicate_reason", "cannot contain duplicate reason codes.");
  }
  const unsigned = Object.freeze({
    schemaVersion: CLASSIFIER_HINT_SCHEMA_VERSION,
    taskKind: ensureEnum(record["taskKind"], `${path}.taskKind`, TASK_KINDS),
    complexity: ensureSafeInteger(record["complexity"], `${path}.complexity`, 1, 5),
    reasoning: ensureEnum(record["reasoning"], `${path}.reasoning`, REASONING_DEMANDS),
    codingRequirement: ensureEnum(
      record["codingRequirement"],
      `${path}.codingRequirement`,
      CLASSIFIER_CODING_REQUIREMENTS
    ),
    confidence: ensureSafeInteger(record["confidence"], `${path}.confidence`, 0, 1_000),
    reasonCodes: Object.freeze(reasonCodes)
  });
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "classifier hint fingerprint"
  });
  if (classifierHintFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match classifier hint content.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createClassifierHint(
  value: Omit<ClassifierHint, "schemaVersion" | "fingerprint">
): ClassifierHint {
  const unsigned = Object.freeze({ schemaVersion: CLASSIFIER_HINT_SCHEMA_VERSION, ...value });
  return parseClassifierHint({ ...unsigned, fingerprint: classifierHintFingerprint(unsigned) });
}

export interface ClassifierStructuralInput {
  readonly requestFingerprint: string;
  readonly unknownFields: readonly ("expected-input-tokens" | "expected-output-tokens" | "repository-scale")[];
  readonly repositoryFileCount: number | null;
  readonly contextItemCount: number | null;
  readonly proposalTaskCount: number | null;
}

export interface ClassifierPort {
  classify(input: ClassifierStructuralInput): Promise<unknown>;
}

const CLASSIFIER_UNKNOWN_FIELDS = Object.freeze([
  "expected-input-tokens",
  "expected-output-tokens",
  "repository-scale"
] as const);

function parseClassifierStructuralInput(
  value: unknown,
  path = "classifier.input"
): ClassifierStructuralInput {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "requestFingerprint",
      "unknownFields",
      "repositoryFileCount",
      "contextItemCount",
      "proposalTaskCount"
    ],
    path
  );
  const unknownFields = [...ensureEnumArray(
    record["unknownFields"],
    `${path}.unknownFields`,
    CLASSIFIER_UNKNOWN_FIELDS,
    CLASSIFIER_UNKNOWN_FIELDS.length
  )].sort(compareText);
  if (new Set(unknownFields).size !== unknownFields.length) {
    fail(`${path}.unknownFields`, "duplicate_unknown", "unknown fields must be unique.");
  }
  const count = (key: "repositoryFileCount" | "contextItemCount" | "proposalTaskCount") =>
    ensureNullable(record[key], (raw) =>
      ensureSafeInteger(raw, `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER)
    );
  return Object.freeze({
    requestFingerprint: ensureString(record["requestFingerprint"], `${path}.requestFingerprint`, {
      minLength: 64,
      maxLength: 64,
      pattern: HEX_64,
      patternName: "request fingerprint"
    }),
    unknownFields: Object.freeze(unknownFields),
    repositoryFileCount: count("repositoryFileCount"),
    contextItemCount: count("contextItemCount"),
    proposalTaskCount: count("proposalTaskCount")
  });
}

export type ClassifierFallbackResult =
  | { readonly outcome: "hint"; readonly hint: ClassifierHint }
  | {
      readonly outcome: "unknown";
      readonly code: "DISABLED" | "NOT_NEEDED" | "UNAVAILABLE" | "MALFORMED" | "LOW_CONFIDENCE";
    };

export interface DeterministicClassifierFallback {
  classify(input: ClassifierStructuralInput): Promise<ClassifierFallbackResult>;
}

export function createDeterministicClassifierFallback(options: {
  readonly port: ClassifierPort | null;
  readonly enabled: boolean;
  readonly minimumConfidence: number;
}): DeterministicClassifierFallback {
  const minimumConfidence = ensureSafeInteger(
    options.minimumConfidence,
    "classifier.minimumConfidence",
    0,
    1_000
  );
  return Object.freeze({
    classify: async (input: ClassifierStructuralInput): Promise<ClassifierFallbackResult> => {
      if (!options.enabled) return Object.freeze({ outcome: "unknown", code: "DISABLED" });
      let parsedInput: ClassifierStructuralInput;
      try {
        parsedInput = parseClassifierStructuralInput(input);
      } catch {
        return Object.freeze({ outcome: "unknown", code: "MALFORMED" });
      }
      if (parsedInput.unknownFields.length === 0) {
        return Object.freeze({ outcome: "unknown", code: "NOT_NEEDED" });
      }
      if (options.port === null) return Object.freeze({ outcome: "unknown", code: "UNAVAILABLE" });
      let raw: unknown;
      try {
        raw = await options.port.classify(
          Object.freeze({
            ...parsedInput,
            unknownFields: Object.freeze([...parsedInput.unknownFields])
          })
        );
      } catch {
        return Object.freeze({ outcome: "unknown", code: "UNAVAILABLE" });
      }
      let hint: ClassifierHint;
      try {
        hint = parseClassifierHint(raw);
      } catch {
        return Object.freeze({ outcome: "unknown", code: "MALFORMED" });
      }
      if (hint.confidence < minimumConfidence) {
        return Object.freeze({ outcome: "unknown", code: "LOW_CONFIDENCE" });
      }
      return Object.freeze({ outcome: "hint", hint });
    }
  });
}
