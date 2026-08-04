import { validation } from "@ai-dev-os/domain";
import {
  MAX_PROPOSAL_DEPENDENCIES,
  MAX_PROPOSAL_LIST_ITEMS,
  MAX_PROPOSAL_TASKS,
  MAX_PROPOSAL_TEXT,
  PROMPT_TEMPLATE_VERSION,
  THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION
} from "@ai-dev-os/prompt-compiler";

const { ensureExactKeys, ensureRecord, ensureSafeInteger, ensureSchemaVersion, fail } = validation;

export const THINKER_SCHEMA_VERSION = 1 as const;
export const THINKER_PLAN_SCHEMA_VERSION = THINKER_PROPOSAL_OUTPUT_SCHEMA_VERSION;
export const THINKER_FINGERPRINT_ALGORITHM_VERSION = 1 as const;

export interface ThinkerConfiguration {
  readonly schemaVersion: typeof THINKER_SCHEMA_VERSION;
  readonly planSchemaVersion: typeof THINKER_PLAN_SCHEMA_VERSION;
  readonly promptTemplateVersion: typeof PROMPT_TEMPLATE_VERSION;
  readonly fingerprintAlgorithmVersion: typeof THINKER_FINGERPRINT_ALGORITHM_VERSION;
  readonly maxOutputTokens: number;
  readonly maxEvents: number;
  readonly maxObservedDeltaBytes: number;
  readonly maxWarnings: number;
  readonly maxAssistantMessages: number;
  readonly maxTasks: number;
  readonly maxDependenciesPerTask: number;
  readonly maxCriteriaPerTask: number;
  readonly maxEvidencePerTask: number;
  readonly maxUnsupportedAssumptionsPerTask: number;
  readonly maxAssumptions: number;
  readonly maxRisks: number;
  readonly maxQuestions: number;
  readonly maxCompletionCriteria: number;
  readonly maxTextLength: number;
  readonly maxTitleLength: number;
  readonly maxObjectiveLength: number;
}

export const DEFAULT_THINKER_CONFIGURATION: ThinkerConfiguration = Object.freeze({
  schemaVersion: THINKER_SCHEMA_VERSION,
  planSchemaVersion: THINKER_PLAN_SCHEMA_VERSION,
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  fingerprintAlgorithmVersion: THINKER_FINGERPRINT_ALGORITHM_VERSION,
  maxOutputTokens: 8_192,
  maxEvents: 4_096,
  maxObservedDeltaBytes: 4_194_304,
  maxWarnings: 32,
  maxAssistantMessages: 16,
  maxTasks: MAX_PROPOSAL_TASKS,
  maxDependenciesPerTask: MAX_PROPOSAL_DEPENDENCIES,
  maxCriteriaPerTask: MAX_PROPOSAL_LIST_ITEMS,
  maxEvidencePerTask: MAX_PROPOSAL_LIST_ITEMS,
  maxUnsupportedAssumptionsPerTask: MAX_PROPOSAL_LIST_ITEMS,
  maxAssumptions: MAX_PROPOSAL_LIST_ITEMS,
  maxRisks: MAX_PROPOSAL_LIST_ITEMS,
  maxQuestions: MAX_PROPOSAL_LIST_ITEMS,
  maxCompletionCriteria: MAX_PROPOSAL_LIST_ITEMS,
  maxTextLength: MAX_PROPOSAL_TEXT,
  maxTitleLength: 240,
  maxObjectiveLength: MAX_PROPOSAL_TEXT
});

export function parseThinkerConfiguration(
  value: unknown,
  path = "thinkerConfiguration"
): ThinkerConfiguration {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "planSchemaVersion",
      "promptTemplateVersion",
      "fingerprintAlgorithmVersion",
      "maxOutputTokens",
      "maxEvents",
      "maxObservedDeltaBytes",
      "maxWarnings",
      "maxAssistantMessages",
      "maxTasks",
      "maxDependenciesPerTask",
      "maxCriteriaPerTask",
      "maxEvidencePerTask",
      "maxUnsupportedAssumptionsPerTask",
      "maxAssumptions",
      "maxRisks",
      "maxQuestions",
      "maxCompletionCriteria",
      "maxTextLength",
      "maxTitleLength",
      "maxObjectiveLength"
    ],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, THINKER_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["planSchemaVersion"],
    `${path}.planSchemaVersion`,
    THINKER_PLAN_SCHEMA_VERSION
  );
  ensureSchemaVersion(
    record["promptTemplateVersion"],
    `${path}.promptTemplateVersion`,
    PROMPT_TEMPLATE_VERSION
  );
  ensureSchemaVersion(
    record["fingerprintAlgorithmVersion"],
    `${path}.fingerprintAlgorithmVersion`,
    THINKER_FINGERPRINT_ALGORITHM_VERSION
  );
  const configuration = Object.freeze({
    schemaVersion: THINKER_SCHEMA_VERSION,
    planSchemaVersion: THINKER_PLAN_SCHEMA_VERSION,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    fingerprintAlgorithmVersion: THINKER_FINGERPRINT_ALGORITHM_VERSION,
    maxOutputTokens: ensureSafeInteger(record["maxOutputTokens"], `${path}.maxOutputTokens`, 1, 1_000_000),
    maxEvents: ensureSafeInteger(record["maxEvents"], `${path}.maxEvents`, 3, 100_000),
    maxObservedDeltaBytes: ensureSafeInteger(
      record["maxObservedDeltaBytes"],
      `${path}.maxObservedDeltaBytes`,
      1_024,
      67_108_864
    ),
    maxWarnings: ensureSafeInteger(record["maxWarnings"], `${path}.maxWarnings`, 0, 32),
    maxAssistantMessages: ensureSafeInteger(
      record["maxAssistantMessages"],
      `${path}.maxAssistantMessages`,
      0,
      16
    ),
    maxTasks: ensureSafeInteger(record["maxTasks"], `${path}.maxTasks`, 0, MAX_PROPOSAL_TASKS),
    maxDependenciesPerTask: ensureSafeInteger(
      record["maxDependenciesPerTask"],
      `${path}.maxDependenciesPerTask`,
      0,
      MAX_PROPOSAL_DEPENDENCIES
    ),
    maxCriteriaPerTask: ensureSafeInteger(
      record["maxCriteriaPerTask"],
      `${path}.maxCriteriaPerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxEvidencePerTask: ensureSafeInteger(
      record["maxEvidencePerTask"],
      `${path}.maxEvidencePerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxUnsupportedAssumptionsPerTask: ensureSafeInteger(
      record["maxUnsupportedAssumptionsPerTask"],
      `${path}.maxUnsupportedAssumptionsPerTask`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxAssumptions: ensureSafeInteger(
      record["maxAssumptions"],
      `${path}.maxAssumptions`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxRisks: ensureSafeInteger(record["maxRisks"], `${path}.maxRisks`, 0, MAX_PROPOSAL_LIST_ITEMS),
    maxQuestions: ensureSafeInteger(
      record["maxQuestions"],
      `${path}.maxQuestions`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxCompletionCriteria: ensureSafeInteger(
      record["maxCompletionCriteria"],
      `${path}.maxCompletionCriteria`,
      0,
      MAX_PROPOSAL_LIST_ITEMS
    ),
    maxTextLength: ensureSafeInteger(
      record["maxTextLength"],
      `${path}.maxTextLength`,
      1,
      MAX_PROPOSAL_TEXT
    ),
    maxTitleLength: ensureSafeInteger(record["maxTitleLength"], `${path}.maxTitleLength`, 1, 240),
    maxObjectiveLength: ensureSafeInteger(
      record["maxObjectiveLength"],
      `${path}.maxObjectiveLength`,
      1,
      MAX_PROPOSAL_TEXT
    )
  });
  if (configuration.maxTitleLength > configuration.maxTextLength) {
    fail(`${path}.maxTitleLength`, "inconsistent_bound", "cannot exceed maxTextLength.");
  }
  if (configuration.maxObjectiveLength > configuration.maxTextLength) {
    fail(`${path}.maxObjectiveLength`, "inconsistent_bound", "cannot exceed maxTextLength.");
  }
  return configuration;
}
