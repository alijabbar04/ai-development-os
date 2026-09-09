/** One authority-free development planning request through the genuine thinker.
 * No canonical store, provider effects, process issuers or account access live
 * here. The caller's host port owns exact confirmation and durable dispatch. */
import { COMPILED_DEFAULT_CONFIGURATION, parseApplicationConfiguration, type ApplicationConfiguration } from "@ai-dev-os/config";
import {
  DEFAULT_CONTEXT_CONFIGURATION, candidateDigest, conservativeUnitEstimator,
  contextRequestFingerprint, parseContextCandidate, parseContextRequest,
  planContextPack, sealContextPack, withContextOverrides,
} from "@ai-dev-os/context";
import { canonicalizeJson, createDataHandlingPolicy, parseDataClassification, toCanonicalJson, validation, type DataClassification } from "@ai-dev-os/domain";
import { createDeterministicPolicyBroker, parsePolicyRule, type PolicyRule } from "@ai-dev-os/policy";
import {
  DEFAULT_PROMPT_COMPILER_CONFIGURATION, THINKER_PROPOSAL_JSON_SCHEMA,
  createPolicyAwarePromptAuthorizer, createPromptCompiler, parsePromptCompilationRequest,
  promptAuthorizationRequestFingerprint, sealPromptTarget,
  type PromptAuthorizationDecision, type PromptAuthorizationRequest, type PromptAuthorizer, type PromptCompilationRequest,
} from "@ai-dev-os/prompt-compiler";
import {
  CLAUDE_PLANNING_PROVIDER_ID, createClaudePlanningInferenceProvider, createPlanningThinkerPort,
  planningInferenceFingerprint, type PlanningInferenceObservation, type PlanningProcessPort,
  type PlanningRequestBinding,
} from "@ai-dev-os/provider-claude-code";
import { PROVIDER_ERROR_CODES, ProviderError, createRetryDisposition, createTrace, parseModelDescriptor, systemClock, type AbortSignalLike, type Clock, type InferenceRequest, type ProviderErrorCode } from "@ai-dev-os/providers";
import { createThinker, type ThinkerProposal, type ThinkerSuccess } from "@ai-dev-os/thinker";
import type { AiPlanningProposal, AiPlanningQuestion, AiPlanningUnderstanding } from "./planning-ai-contracts.js";
import { parseAiProposal, parseAiQuestions, parseAiUnderstanding } from "./planning-ai-validation.js";

const MAX_CONTEXT_BYTES = 32_768;
const INSTANCE_ID = "development-claude-planning";
const ALIAS = "development-planning";
const ZERO_DIGEST = "0".repeat(64);
const compilerConfiguration = Object.freeze({ ...DEFAULT_PROMPT_COMPILER_CONFIGURATION,
  maxPromptBytes: 65_536, maxMessageBytes: 49_152, maxContextBytes: 49_152,
  maxOutputTokens: 8_192, maxAuthorizationAgeMs: 120_000,
});

export interface AiPlanningBindingIdentity {
  readonly requestId: string;
  readonly sessionId: string;
  readonly projectId: string;
}
export interface AiPlanningInferenceInput {
  readonly purpose: "understanding" | "proposal";
  readonly context: unknown;
  readonly bindingIdentity: AiPlanningBindingIdentity;
  readonly host: PlanningProcessPort;
  readonly clock?: Clock;
  readonly signal?: AbortSignalLike;
  readonly onObservation?: (observation: PlanningInferenceObservation) => void;
}
export interface AiPlanningInferenceResult {
  readonly output: { readonly understanding: AiPlanningUnderstanding; readonly questions: readonly AiPlanningQuestion[] } | AiPlanningProposal | null;
  /** Original genuine ThinkerSuccess, never restamped as operator-authored. */
  readonly contribution: ThinkerSuccess;
  readonly contributionDigest: string;
  readonly routeFingerprint: string;
  readonly narrativeRef: string;
  readonly refusalReason: string | null;
}
export interface PreparedAiPlanningInference {
  readonly binding: PlanningRequestBinding;
  readonly inferenceRequest: InferenceRequest;
  readonly compilation: PromptCompilationRequest;
  readonly configuration: ApplicationConfiguration;
  readonly authorizer: PromptAuthorizer;
  readonly inputContextDigest: string;
}

function invalid(message: string): never { throw new ProviderError("INVALID_REQUEST", message); }

function purposeInstructions(purpose: AiPlanningInferenceInput["purpose"]): string {
  return purpose === "understanding"
    ? "Describe an editable understanding of this project. Use objective as its concise summary, completionCriteria as proposed user outcomes, and assumptions for explicit uncertainties. Include at least one model-proposed audience as an assumption beginning 'Audience: '. Put excluded scope, if any, in assumptions beginning 'Non-goal: '. Ask only material openQuestions, at most three. Use clarification-required when an answer matters. Do not claim any proposed requirement is accepted. Do not propose implementation tasks yet."
    : "Propose a finite task plan for the explicitly accepted project brief in the supplied context. Use objective as a concise plan title and tasks with clear descriptions, acceptance criteria and dependencies. Tasks describe future work only. Use kind plan, editScope none, and reasoning/structured-output capabilities; no execution is authorized. Preserve assumptions, risks and unresolved questions. Return blocked or clarification-required when the accepted requirements cannot support a viable proposal. Do not invent evidence, approval or completion claims.";
}

function compilationPolicy(at: string, classification: DataClassification): PromptAuthorizer {
  // These rules authorize only the explicitly reviewed project-data compiler. They do not
  // admit any process, network, coding or production effect. Exact native
  // consent and dispatch authority are separately checked by the host port.
  const rules: readonly PolicyRule[] = ["provider-disclosure", "model-eligibility"].map((action) => parsePolicyRule({
    schemaVersion: 1, id: `development-planning-${action}`, authority: "project", effect: "allow",
    actions: [action], classifications: [classification], risks: ["low"], requiredTransformations: [],
    approval: null, requiredLocality: "any", forbidInputLogging: true, forbidOutputLogging: true,
    forbidArtifactPersistence: false, forbidRetention: false, maxRetentionDays: null,
    forbiddenCapabilities: ["tool-calling", "image-input", "repository-editing", "command-execution", "network-access", "resumability"],
  }));
  // Evaluate both policy actions against this real captured admission instant.
  // It is an immutable decision snapshot, not a launch clock or a clock setter.
  const broker = createDeterministicPolicyBroker({ policyVersion: "development-planning-v1", rules, clock: { now: () => new Date(at) } });
  const underlying = createPolicyAwarePromptAuthorizer({ broker, authorizationTtlMs: 120_000 });
  let cached: { fingerprint: string; decision: PromptAuthorizationDecision } | null = null;
  return Object.freeze({ async authorize(request: PromptAuthorizationRequest) {
    const fingerprint = promptAuthorizationRequestFingerprint(request);
    if (cached !== null) {
      if (cached.fingerprint !== fingerprint) invalid("The compiled planning request changed after disclosure preparation.");
      return cached.decision;
    }
    const decision = await underlying.authorize(request);
    cached = { fingerprint, decision };
    return decision;
  } });
}

/** Effect-free preparation exposes the exact compiled request for host consent. */
export async function prepareAiPlanningInference(input: AiPlanningInferenceInput): Promise<PreparedAiPlanningInference> {
  const clock = input.clock ?? systemClock;
  const route = input.host.status();
  if (route.state !== "qualified") throw new ProviderError("POLICY_DENIED", "The Claude Code subscription route is blocked before authentication or inference: managed-policy isolation is unqualified.");
  if (input.purpose !== "understanding" && input.purpose !== "proposal") invalid("Unknown planning purpose.");
  const identity = validation.ensureRecord(input.bindingIdentity, "planningIdentity");
  validation.ensureExactKeys(identity, ["requestId", "sessionId", "projectId"], "planningIdentity");
  const id = (key: string) => validation.ensureString(identity[key], key, { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "stable ID" });
  const requestId = id("requestId"), sessionId = id("sessionId"), projectId = id("projectId");
  const context = canonicalizeJson(input.context);
  if (context === null || typeof context !== "object" || Array.isArray(context) || Buffer.byteLength(toCanonicalJson(context), "utf8") > MAX_CONTEXT_BYTES) invalid("The planning context must be a bounded project snapshot.");
  const classification = parseDataClassification((context as Record<string, unknown>)["dataClassification"]);
  if (classification !== "public" && classification !== "internal") throw new ProviderError("POLICY_DENIED", "This development planning route does not authorize proprietary-source, personal or secret context.");
  // Rejection only: no data is silently edited, downgraded or claimed redacted.
  // This bounded guard catches recognizable credential-shaped input; it is not
  // a claim that a general scanner has removed every possible secret.
  const contextText = toCanonicalJson(context);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bBearer\s+[A-Za-z0-9._~-]{20,}|\b(?:api[_ -]?key|access[_ -]?token|password|client[_ -]?secret)\s*["']?\s*[:=]\s*["']?\s*[A-Za-z0-9+/_=.~-]{8,}/iu.test(contextText)) throw new ProviderError("POLICY_DENIED", "The planning input contains credential-shaped data. Remove it before requesting disclosure.");
  const model = parseModelDescriptor(route.model);
  const at = clock.now().toISOString();
  const deadline = new Date(clock.now().valueOf() + 120_000).toISOString();
  const provisional: PlanningRequestBinding = { requestId, sessionId, projectId, instanceId: INSTANCE_ID,
    modelId: model.model.modelId, configurationFingerprint: route.configurationFingerprint,
    qualificationFingerprint: route.qualificationFingerprint, deadline, contextDigest: ZERO_DIGEST,
    schemaDigest: planningInferenceFingerprint(THINKER_PROPOSAL_JSON_SCHEMA), maxInputBytes: 65_536,
    maxOutputBytes: 524_288, maxOutputTokens: 8_192 };
  // Descriptor construction and model listing are effect-free. This provisional
  // instance is never started; only the compiled exact binding is used below.
  const descriptorProvider = createClaudePlanningInferenceProvider({ host: input.host, binding: provisional, clock });
  const selected = await descriptorProvider.listModels();
  if (selected.length !== 1) throw new ProviderError("MODEL_UNAVAILABLE", "Planning requires one exact qualified model.");
  const target = sealPromptTarget({ schemaVersion: 1, instanceId: INSTANCE_ID, provider: descriptorProvider.describe(), model: selected[0]!.model });
  await descriptorProvider.close();
  const inputContextDigest = planningInferenceFingerprint(context);
  const body = toCanonicalJson({ request: purposeInstructions(input.purpose), projectInformation: context });
  const configured = withContextOverrides(DEFAULT_CONTEXT_CONFIGURATION, {
    maxClassification: classification, includeUnconfirmedCandidates: false, verifySourceDigests: true,
    budget: { maxTotalBytes: 65_536, maxTotalUnits: 21_846, maxItems: 4, maxItemBytes: 49_152,
      minItemBytes: 1, maxBytesPerSourceKind: 49_152, allowTruncation: false,
      categories: { ...DEFAULT_CONTEXT_CONFIGURATION.budget.categories, task: { reservedBytes: 2_048, maxBytes: 49_152, maxItems: 4 } } },
  });
  if (!configured.ok) invalid("The bounded planning context configuration is invalid.");
  const contextConfiguration = configured.value;
  const contextRequest = parseContextRequest({ schemaVersion: 1, requestId, purpose: "planning", projectId,
    workspaceId: null, taskDescription: purposeInstructions(input.purpose), subjectDigest: inputContextDigest, requestedAt: at });
  const candidate = parseContextCandidate({ sourceKind: "task-description", category: "task",
    identity: `planning-context:${planningInferenceFingerprint({ projectId, sessionId }).slice(0, 32)}`,
    digest: candidateDigest(body), classification, disclosure: "project-internal",
    scopeLabel: planningInferenceFingerprint({ projectId }).slice(0, 32),
    provenance: { locator: "explicit-planning-project-information", sourceDigest: candidateDigest(body), originFingerprint: inputContextDigest },
    observedAt: at, baseScore: 1_000, extractionRange: null, trust: "untrusted", body });
  const plan = planContextPack({ candidates: [candidate], configuration: contextConfiguration, estimator: conservativeUnitEstimator });
  if (!plan.ok || plan.value.items.length !== 1 || plan.value.omissions.length !== 0) invalid("The complete approved project context does not fit the planning bound.");
  const requestFingerprint = contextRequestFingerprint({ request: contextRequest, configuration: contextConfiguration,
    estimatorId: conservativeUnitEstimator.estimatorId, policyDecisionFingerprint: null });
  const pack = sealContextPack({ schemaVersion: 1, selectionAlgorithmVersion: 1, requestFingerprint, generatedAt: at,
    items: plan.value.items, omissions: plan.value.omissions, omissionsTruncated: plan.value.omissionsTruncated,
    usage: plan.value.usage, estimator: { estimatorId: conservativeUnitEstimator.estimatorId, exact: false, bytesPerUnit: conservativeUnitEstimator.bytesPerUnit }, diagnostics: plan.value.diagnostics });
  const trace = createTrace(`planning:${planningInferenceFingerprint({ requestId }).slice(0, 40)}`);
  const compilation = parsePromptCompilationRequest({ schemaVersion: 1, requestId,
    context: { request: contextRequest, configuration: contextConfiguration, policyDecisionFingerprint: null, pack },
    taskRequirements: { kind: "plan", complexity: 2, risk: "low", reasoning: "medium", editScope: "none",
      capabilities: ["reasoning", "structured-output"], dataClassification: classification, expectedInputTokens: null, expectedOutputTokens: null },
    authority: { schemaVersion: 1, minimumRisk: "low", minimumClassification: classification,
      permittedTaskKinds: ["plan"], capabilityCeiling: ["reasoning", "structured-output"], editScopeCeiling: "none", reasoningCeiling: "high",
      maxTasks: input.purpose === "understanding" ? 0 : 12, maxDependenciesPerTask: 12, maxCriteriaPerTask: 8,
      maxEvidencePerTask: 8, maxUnsupportedAssumptionsPerTask: 8, maxAssumptions: 12, maxRisks: 12,
      maxQuestions: 3, maxCompletionCriteria: 12, maxTextLength: 2_000, maxTitleLength: 240, maxObjectiveLength: 300 },
    // The State18 capability owns this narrow exact-context disclosure policy.
    // It preserves the canonical classification and forbids internal-data
    // training. Native host admission remains mandatory; no transformation or
    // existing general policy approval is invented to satisfy this compiler.
    target, policy: { handlingPolicy: createDataHandlingPolicy({ classification, cloudProvidersAllowed: true,
      localExecutionRequired: false, redactionsRequiredBeforeDisclosure: [], logRetentionAllowed: false,
      artifactPersistenceAllowed: true, humanApprovalRequired: false,
      disallowedProviderCapabilities: classification === "internal" ? ["model-training", "third-party-sharing"] : ["third-party-sharing"] }),
      scope: { projectId, taskId: null, providerInstanceId: INSTANCE_ID, workspaceId: null, operationId: null, traceId: trace.traceId },
      transformationsApplied: [], transformationEvidence: [], approvalEvidence: [], retentionDays: null },
    trace, authorizationAt: at, deadline, extensions: [] });
  const authorizer = compilationPolicy(at, classification);
  const compiled = await createPromptCompiler({ authorizer, configuration: compilerConfiguration }).compile(compilation);
  if (!compiled.ok) throw new ProviderError("POLICY_DENIED", "The planning prompt did not pass its compiler and disclosure policy.", { causeCode: compiled.failure.code });
  const binding: PlanningRequestBinding = Object.freeze({ ...provisional, contextDigest: planningInferenceFingerprint(compiled.value.inferenceRequest.messages) });
  const configuration = parseApplicationConfiguration({ ...COMPILED_DEFAULT_CONFIGURATION,
    providers: [{ instanceId: INSTANCE_ID, providerId: CLAUDE_PLANNING_PROVIDER_ID, kind: "inference", enabled: true, locality: "cloud", credentialRef: null, endpointId: null, extensions: [] }],
    modelAliases: [{ alias: ALIAS, providerInstanceId: INSTANCE_ID, modelId: model.model.modelId }],
    modelPreferences: [{ role: "planning", aliases: [ALIAS] }],
  });
  return Object.freeze({ binding, inferenceRequest: compiled.value.inferenceRequest, compilation, configuration, authorizer, inputContextDigest });
}

function projection(purpose: AiPlanningInferenceInput["purpose"], proposal: ThinkerProposal): Pick<AiPlanningInferenceResult, "output" | "refusalReason"> {
  if (proposal.status === "blocked") return { output: null, refusalReason: "The model could not propose a viable plan. Its retained contribution explains the limitations." };
  if (purpose === "proposal" && proposal.status !== "viable") return { output: null, refusalReason: "The model needs clarification before a proposal can be adopted. Review its retained questions." };
  try {
    if (purpose === "proposal") return { refusalReason: null, output: parseAiProposal({ title: proposal.objective,
      tasks: proposal.tasks.map((task) => ({ taskId: task.proposalId, title: task.title, objective: task.description,
        acceptanceCriteria: task.acceptanceCriteria, dependsOn: task.dependencies })) }) };
    const audiences = proposal.assumptions.filter((text) => text.startsWith("Audience: ")).map((text) => text.slice("Audience: ".length));
    const nonGoals = proposal.assumptions.filter((text) => text.startsWith("Non-goal: ")).map((text) => text.slice("Non-goal: ".length));
    const assumptions = proposal.assumptions.filter((text) => !text.startsWith("Audience: ") && !text.startsWith("Non-goal: "));
    const understanding = parseAiUnderstanding({ summary: proposal.objective, outcomes: proposal.completionCriteria, audiences, nonGoals, assumptions });
    const questions = parseAiQuestions(proposal.openQuestions.map((question) => ({
      questionId: `question:${planningInferenceFingerprint(question).slice(0, 32)}`, question,
      whyItMatters: "This point remains unresolved in the model's proposed understanding.",
      proposedDefault: "No default is accepted. Answer, revise or decline this question.",
      blocking: proposal.status === "clarification-required",
    })));
    return { output: Object.freeze({ understanding, questions }), refusalReason: null };
  } catch {
    return { output: null, refusalReason: "The model output is incomplete for an editable brief or task plan. Its original contribution remains saved." };
  }
}

export async function runAiPlanningInference(input: AiPlanningInferenceInput): Promise<AiPlanningInferenceResult> {
  const prepared = await prepareAiPlanningInference(input);
  const clock = input.clock ?? systemClock;
  const provider = createClaudePlanningInferenceProvider({ host: input.host, binding: prepared.binding, clock,
    ...(input.onObservation === undefined ? {} : { observer: input.onObservation }) });
  const port = await createPlanningThinkerPort(provider);
  const thinker = createThinker({ port, authorizer: prepared.authorizer, promptCompilerConfiguration: compilerConfiguration, clock });
  try {
    const result = await thinker.think({ schemaVersion: 1, requestId: prepared.binding.requestId,
      configuration: prepared.configuration, selectedAlias: ALIAS, compilation: prepared.compilation },
    input.signal === undefined ? {} : { signal: input.signal });
    if (!result.ok) {
      const underlying = result.failure.details["causeCode"];
      const reported = result.failure.code === "CANCELLED" || result.failure.code === "DEADLINE_EXCEEDED" ? result.failure.code : underlying;
      const code: ProviderErrorCode = typeof reported === "string" && (PROVIDER_ERROR_CODES as readonly string[]).includes(reported) ? reported as ProviderErrorCode : "MALFORMED_RESPONSE";
      throw new ProviderError(code, "The planning contribution failed genuine thinker validation.", { causeCode: result.failure.code },
        { retry: createRetryDisposition({ strategy: "human-action", requestReusable: false, operationMayStillBeRunning: true }) });
    }
    const contribution = result.value;
    const contributionDigest = planningInferenceFingerprint(contribution);
    return Object.freeze({ ...projection(input.purpose, contribution.proposal), contribution, contributionDigest,
      routeFingerprint: contribution.target.gatewayFingerprint, narrativeRef: `nar:${contributionDigest}` });
  } finally {
    await thinker.close();
    await provider.close();
  }
}
