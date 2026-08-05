import { createHash } from "node:crypto";
import {
  buildRepositoryIndex,
  DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
  type RepositoryIndex
} from "@ai-dev-os/repository-index";
import {
  createManualIndexClock,
  createMemorySnapshotPort
} from "@ai-dev-os/repository-index/testing/fixtures";
import {
  compileThinkerPrompt,
  type CompiledThinkerPrompt
} from "@ai-dev-os/prompt-compiler";
import {
  allowingPromptAuthorizer,
  promptCompilationRequestFixture
} from "@ai-dev-os/prompt-compiler/testing/fixtures";
import {
  createTaskRequirements,
  type TaskRequirements,
  type TaskRequirementsInput
} from "@ai-dev-os/domain";
import { parseThinkerProposal, type ThinkerProposal } from "@ai-dev-os/thinker";
import {
  CLASSIFIER_HINT_SCHEMA_VERSION,
  classifierHintFingerprint,
  type ClassifierHint
} from "../classifier.js";
import {
  createConservativeTokenEstimator,
  createTokenEstimatorDescriptor,
  type TokenEstimatorApplicability,
  type TokenEstimatorCountInput,
  type TokenEstimatorDescriptor
} from "../estimator.js";
import {
  PROFILER_SCHEMA_VERSION,
  createTaskAuthorityCeilings,
  parseTaskProfileRequest,
  type TaskAuthorityCeilings,
  type TaskProfileRequest
} from "../profiler.js";

export const PROFILER_FIXTURE_EPOCH = "2026-08-05T10:00:00.000Z";
export const PROFILER_PROPERTY_SEEDS = Object.freeze([160_316, 160_317, 1_051_920]);
export const PROFILER_LEAK_CANARY = "STAGE16-PROFILER-CANARY-19C4";

export function sha256Fixture(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function taskRequirementsFixture(
  overrides: Partial<TaskRequirementsInput> = {}
): TaskRequirements {
  return createTaskRequirements({
    kind: "implement",
    complexity: 3,
    risk: "medium",
    reasoning: "high",
    editScope: "multi-file",
    capabilities: Object.freeze([
      "reasoning",
      "repository-read",
      "code-edit",
      "testing",
      "structured-output"
    ]),
    dataClassification: "internal",
    expectedInputTokens: null,
    expectedOutputTokens: 4_096,
    ...overrides
  });
}

export function taskAuthorityCeilingsFixture(
  overrides: Partial<Omit<TaskAuthorityCeilings, "authority" | "fingerprint">> = {}
): TaskAuthorityCeilings {
  return createTaskAuthorityCeilings({
    minimumRisk: "medium",
    minimumClassification: "internal",
    maximumEditScope: "cross-package",
    requiredCapabilities: Object.freeze(["reasoning", "structured-output"]),
    requiredLocality: "any",
    approvalRequired: false,
    ...overrides
  });
}

export function classifierHintFixture(
  overrides: Partial<Omit<ClassifierHint, "schemaVersion" | "fingerprint">> = {}
): ClassifierHint {
  const unsigned = Object.freeze({
    schemaVersion: CLASSIFIER_HINT_SCHEMA_VERSION,
    taskKind: "implement" as const,
    complexity: 4,
    reasoning: "high" as const,
    codingRequirement: "edit" as const,
    confidence: 900,
    reasonCodes: Object.freeze(["bounded-structural-hint"]),
    ...overrides
  });
  return Object.freeze({ ...unsigned, fingerprint: classifierHintFingerprint(unsigned) });
}

export function thinkerProposalFixture(): ThinkerProposal {
  return parseThinkerProposal(Object.freeze({
    schemaVersion: 1,
    status: "viable",
    objective: `Structural fixture ${PROFILER_LEAK_CANARY}`,
    assumptions: Object.freeze(["A fixture assumption"]),
    risks: Object.freeze(["A fixture risk"]),
    openQuestions: Object.freeze([]),
    completionCriteria: Object.freeze(["Tests pass"]),
    tasks: Object.freeze([
      Object.freeze({
        proposalId: "task-alpha",
        kind: "implement",
        title: "Implement fixture",
        description: `Never expose this body ${PROFILER_LEAK_CANARY}`,
        dependencies: Object.freeze([]),
        acceptanceCriteria: Object.freeze(["One", "Two"]),
        evidence: Object.freeze([
          Object.freeze({ identity: "fixture-evidence", digest: sha256Fixture("evidence") })
        ]),
        unsupportedAssumptions: Object.freeze(["Unknown fixture fact"]),
        complexity: 4,
        reasoning: "high",
        capabilities: Object.freeze([
          "reasoning",
          "repository-read",
          "code-edit",
          "testing",
          "structured-output"
        ]),
        editScope: "multi-file",
        risk: "high",
        classification: "proprietary-source"
      })
    ])
  }));
}

export function taskProfileRequestFixture(
  overrides: Partial<TaskProfileRequest> = {}
): TaskProfileRequest {
  return parseTaskProfileRequest({
    schemaVersion: PROFILER_SCHEMA_VERSION,
    profiledAt: PROFILER_FIXTURE_EPOCH,
    requirements: taskRequirementsFixture(),
    authorityCeilings: taskAuthorityCeilingsFixture(),
    repositoryIndex: null,
    contextPack: null,
    compiledPrompt: null,
    thinkerProposal: thinkerProposalFixture(),
    selectedProposalTaskId: "task-alpha",
    classifierHint: null,
    allowClassifierFallback: false,
    ...overrides
  });
}

export async function repositoryIndexFixture(options: {
  readonly large?: boolean;
  readonly limitExhausted?: boolean;
} = {}): Promise<RepositoryIndex> {
  const repeat = options.large ? 128 : 2;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "fixture-package",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { "fixture-dependency": "1.0.0" }
    })
  };
  for (let index = 0; index < repeat; index += 1) {
    files[`packages/p${index}/src/index.ts`] = `export const value${index} = ${index};\n`;
  }
  const result = await buildRepositoryIndex({
    readPort: createMemorySnapshotPort({ files }),
    configuration: options.limitExhausted
      ? Object.freeze({
          ...DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
          limits: Object.freeze({ ...DEFAULT_REPOSITORY_INDEX_CONFIGURATION.limits, maxFiles: 1 })
        })
      : DEFAULT_REPOSITORY_INDEX_CONFIGURATION,
    clock: createManualIndexClock(PROFILER_FIXTURE_EPOCH)
  });
  if (!result.ok) throw new Error("Repository fixture failed to build.");
  return result.value;
}

export async function compiledPromptFixture(): Promise<{
  readonly prompt: CompiledThinkerPrompt;
  readonly contextPack: TaskProfileRequest["contextPack"];
}> {
  const request = promptCompilationRequestFixture({
    body: `Untrusted fixture context ${PROFILER_LEAK_CANARY}`
  });
  const result = await compileThinkerPrompt(request, {
    authorizer: allowingPromptAuthorizer({ epoch: request.authorizationAt })
  });
  if (!result.ok) throw new Error("Prompt fixture failed to compile.");
  return Object.freeze({ prompt: result.value, contextPack: request.context.pack });
}

export async function fullTaskProfileRequestFixture(): Promise<TaskProfileRequest> {
  const [repositoryIndex, prompt] = await Promise.all([
    repositoryIndexFixture(),
    compiledPromptFixture()
  ]);
  return taskProfileRequestFixture({
    repositoryIndex,
    contextPack: prompt.contextPack,
    compiledPrompt: prompt.prompt
  });
}

export const TOKEN_ESTIMATOR_BINDING_FIXTURE: TokenEstimatorApplicability = Object.freeze({
  providerId: "fixture-provider",
  transportProfileId: "fixture-transport-v1",
  contractModelId: "fixture-model",
  catalogModelFingerprint: sha256Fixture("fixture-catalog-model")
});

export function exactTokenEstimatorFixture(): TokenEstimatorDescriptor {
  return createTokenEstimatorDescriptor({
    estimatorId: "fixture-exact-framing",
    algorithmVersion: 1,
    applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
    accuracy: "exact",
    evidence: Object.freeze({
      kind: "tokenizer-and-complete-framing",
      referenceFingerprint: sha256Fixture("synthetic exact framing specification"),
      specificationVersion: "fixture-v1",
      framingComplete: true
    }),
    maximumInputBytes: 1_000_000,
    safetyMarginBps: 0,
    port: Object.freeze({
      count: (input: TokenEstimatorCountInput) => Object.freeze({
        messageTokens:
          input.compiledPrompt.accounting.promptBytes - input.compiledPrompt.accounting.schemaBytes,
        schemaTokens: input.compiledPrompt.accounting.schemaBytes,
        toolTokens: input.toolDefinitionBytes,
        imageTokens: input.imageMetadataBytes,
        artifactTokens: input.artifactMetadataBytes,
        fixedOverheadTokens: 7
      })
    })
  });
}

export function conservativeTokenEstimatorFixture(
  accuracy: "proven-upper-bound" | "heuristic" = "proven-upper-bound"
): TokenEstimatorDescriptor {
  return createConservativeTokenEstimator({
    estimatorId: `fixture-${accuracy}`,
    applicability: TOKEN_ESTIMATOR_BINDING_FIXTURE,
    accuracy,
    evidence: Object.freeze({
      kind: accuracy === "heuristic" ? "heuristic-ratio" : "declared-conservative-bound",
      referenceFingerprint: sha256Fixture(`fixture-${accuracy}-evidence`),
      specificationVersion: "fixture-v1",
      framingComplete: accuracy !== "heuristic"
    }),
    bytesPerTokenNumerator: 1,
    bytesPerTokenDenominator: 1,
    fixedOverheadTokens: 9,
    safetyMarginBps: accuracy === "heuristic" ? 2_500 : 0
  });
}
