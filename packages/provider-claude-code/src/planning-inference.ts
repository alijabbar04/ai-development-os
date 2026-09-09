/**
 * Separate authority-free inference adapter. This is not the coding adapter or
 * Stage 17 containment. There is no process creation, credential access, route
 * qualification issuer or API fallback here. Only a trusted host port can own
 * admission; the shipped connection below is unconditionally unavailable.
 */
import { createHash, randomUUID } from "node:crypto";
import { toCanonicalJson, validation, type DataClassification, type JsonValue } from "@ai-dev-os/domain";
import {
  ProviderError, UNKNOWN_COST, createOperationController, createRetryDisposition,
  guardProviderOperation, parseDeadline, parseInferenceEvent, parseInferenceRequest,
  parseInferenceResult, parseModelDescriptor, parseProviderDescriptor,
  parseProviderOperationId, parseProviderUsage, systemClock,
  type Clock, type InferenceEvent, type InferenceOperation, type InferenceProvider,
  type InferenceRequest, type InferenceResult, type ModelDescriptor, type ProviderErrorCode,
  type ProviderDescriptor, type ProviderUsage, type StartOperationOptions,
} from "@ai-dev-os/providers";
import { validatePlanningJsonSchema, validatePlanningStructuredOutput } from "./planning-schema.js";

export const CLAUDE_PLANNING_PROVIDER_ID = "claude-code-planning";
export const CLAUDE_PLANNING_PROTOCOL = "claude-print-json-2.1.263-v1";
export const PLANNING_LOCAL_REQUEST_CAP = 3;
export const PLANNING_MAX_DEADLINE_MS = 120_000;
export const PLANNING_ROUTE_BLOCKED_REASON = "MANAGED_POLICY_ISOLATION_UNQUALIFIED";

export type PlanningRouteStatus = {
  readonly state: "LIVE_ROUTE_BLOCKED";
  readonly modelId: null;
  readonly subscriptionAllowance: "unknown";
  readonly reasons: readonly string[];
  readonly detail: string;
} | {
  readonly state: "qualified";
  /** A synthetic port never represents an owned subscription connection. */
  readonly source: "owned-subscription" | "synthetic-fixture";
  readonly model: ModelDescriptor;
  readonly configurationFingerprint: string;
  readonly qualificationFingerprint: string;
  readonly protocol: typeof CLAUDE_PLANNING_PROTOCOL;
  readonly subscriptionAllowance: "unknown";
  readonly expiresAt: string;
  readonly disclosure: {
    readonly retainsData: boolean;
    readonly trainsOnInputs: boolean;
    readonly supportedClassifications: readonly DataClassification[];
  };
};

/** Constructed by the application from durable context and exact confirmation. */
export interface PlanningRequestBinding {
  readonly requestId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly contextDigest: string;
  readonly schemaDigest: string;
  readonly modelId: string;
  readonly instanceId: string;
  readonly configurationFingerprint: string;
  readonly qualificationFingerprint: string;
  readonly deadline: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
}

/** Opaque identity: a host must retain and verify the exact issued object. */
export interface PlanningAdmission { readonly receiptId: string }

export interface PlanningInvocation {
  readonly protocol: typeof CLAUDE_PLANNING_PROTOCOL;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly maxOutputBytes: number;
  readonly deadline: string;
}

export interface PlanningProcessOutcome {
  readonly state: "exited" | "cancelled" | "deadline" | "termination-unconfirmed";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly terminationConfirmed: boolean;
}

export interface PlanningProcessPort {
  /** Effect-free metadata; it must never run a status helper or read credentials. */
  status(): PlanningRouteStatus;
  /** No process/network effects; checks exact native confirmation, cap and stop. */
  authorize(binding: PlanningRequestBinding, requestFingerprint: string): Promise<PlanningAdmission>;
  /** Rechecks revocation, stop, context and qualification immediately before spawn. */
  assertCurrent(admission: PlanningAdmission, binding: PlanningRequestBinding, requestFingerprint: string): Promise<void> | void;
  /** Host persists dispatch before launch and owns argv verification, stdin,
   * output/deadline bounds and cancellation/drain. No renderer supplies this port. */
  execute(input: {
    readonly admission: PlanningAdmission;
    readonly binding: PlanningRequestBinding;
    readonly requestFingerprint: string;
    readonly invocation: PlanningInvocation;
    readonly signal: AbortSignal;
  }): Promise<PlanningProcessOutcome>;
}

export type PlanningUsageObservation = {
  readonly state: "unknown";
  readonly value: null;
  readonly subscriptionEquivalentUsd: null;
} | {
  readonly state: "reported";
  readonly value: ProviderUsage;
  /** Vendor API-equivalent estimate, never a subscription charge. */
  readonly subscriptionEquivalentUsd: number | null;
};

export interface PlanningInferenceObservation {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly state: "dispatched" | "succeeded" | "failed" | "cancelled";
  readonly code: ProviderErrorCode | null;
  readonly usage: PlanningUsageObservation;
  readonly terminationConfirmed: boolean;
}

export interface ClaudePlanningInferenceProvider extends InferenceProvider {
  routeStatus(): PlanningRouteStatus;
}

const unknownUsage: PlanningUsageObservation = Object.freeze({ state: "unknown", value: null, subscriptionEquivalentUsd: null });
const { ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } = validation;

function failure(code: ProviderErrorCode, detail: string): ProviderError {
  return new ProviderError(code, detail, {}, { retry: createRetryDisposition({ strategy: "human-action", requestReusable: false, operationMayStillBeRunning: true }) });
}

/** Hashes the exact canonical data sent or bound; it does not grant authority. */
export function planningInferenceFingerprint(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value), "utf8").digest("hex");
}

export function parsePlanningRequestBinding(value: unknown): PlanningRequestBinding {
  const row = ensureRecord(value, "planningBinding");
  ensureExactKeys(row, ["requestId", "sessionId", "projectId", "contextDigest", "schemaDigest", "modelId", "instanceId", "configurationFingerprint", "qualificationFingerprint", "deadline", "maxInputBytes", "maxOutputBytes", "maxOutputTokens"], "planningBinding");
  const id = (key: string) => ensureString(row[key], key, { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, patternName: "stable ID" });
  const digest = (key: string) => ensureString(row[key], key, { maxLength: 64, pattern: /^[0-9a-f]{64}$/u, patternName: "sha-256" });
  return Object.freeze({
    requestId: id("requestId"), sessionId: id("sessionId"), projectId: id("projectId"),
    contextDigest: digest("contextDigest"), schemaDigest: digest("schemaDigest"), modelId: id("modelId"), instanceId: id("instanceId"),
    configurationFingerprint: digest("configurationFingerprint"), qualificationFingerprint: digest("qualificationFingerprint"),
    deadline: parseDeadline(row["deadline"]),
    maxInputBytes: ensureSafeInteger(row["maxInputBytes"], "maxInputBytes", 1, 65_536),
    maxOutputBytes: ensureSafeInteger(row["maxOutputBytes"], "maxOutputBytes", 1, 524_288),
    maxOutputTokens: ensureSafeInteger(row["maxOutputTokens"], "maxOutputTokens", 1, 8_192),
  });
}

/** Real production-launch connection: metadata and flags cannot open this gate. */
export function createBlockedPlanningProcessPort(): PlanningProcessPort {
  const status: PlanningRouteStatus = Object.freeze({
    state: "LIVE_ROUTE_BLOCKED", modelId: null, subscriptionAllowance: "unknown",
    reasons: Object.freeze([PLANNING_ROUTE_BLOCKED_REASON]),
    detail: "The installed Claude Code isolation flags do not prove managed hooks, status-line, file-suggestion and policy helpers cannot execute. No authentication or inference is launched. Model not qualified.",
  });
  const refuse = (): never => { throw failure("POLICY_DENIED", status.detail); };
  return Object.freeze({ status: () => status, authorize: async () => refuse(), assertCurrent: refuse, execute: async () => refuse() });
}

function checkedRequest(raw: InferenceRequest, binding: PlanningRequestBinding): InferenceRequest {
  const request = parseInferenceRequest(raw);
  const roles = request.messages.map((message) => message.role).join(",");
  if (request.requestId !== binding.requestId || request.modelId !== binding.modelId || request.deadline !== binding.deadline ||
    request.maxOutputTokens === null || request.maxOutputTokens > binding.maxOutputTokens ||
    request.tools.length !== 0 || request.toolChoice?.mode !== "none" || request.extensions.length !== 0 ||
    request.sampling !== null || request.stopSequences.length !== 0 || request.structuredOutput?.strict !== true ||
    !["user", "system,user", "system,developer,user"].includes(roles) ||
    request.messages.some((message) => message.parts.length !== 1 || message.parts[0]?.type !== "text")) {
    throw failure("INVALID_REQUEST", "The planning request exceeds its exact no-tools admission binding.");
  }
  const schema = validatePlanningJsonSchema(request.structuredOutput.schema);
  if (planningInferenceFingerprint(schema) !== binding.schemaDigest || planningInferenceFingerprint(request.messages) !== binding.contextDigest) {
    throw failure("INVALID_REQUEST", "The planning request context or schema differs from its bound subject.");
  }
  return request;
}

export interface PlanningValidatedResponse {
  readonly structuredOutput: JsonValue;
  readonly usage: Extract<PlanningUsageObservation, { state: "reported" }>;
}

/** Strict pinned print-result surface. Unknown authority/tool-bearing fields
 * fail closed; this codec is not evidence that a live route is qualified. */
export function parsePlanningPrintResult(bytes: Uint8Array, binding: PlanningRequestBinding, schema: unknown): PlanningValidatedResponse {
  try {
    if (bytes.byteLength > binding.maxOutputBytes) throw new Error("bounded");
    const row = ensureRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "planningResult");
    ensureExactKeys(row, ["type", "subtype", "is_error", "duration_ms", "duration_api_ms", "num_turns", "result", "session_id", "total_cost_usd", "usage", "modelUsage", "permission_denials", "structured_output", "uuid", "stop_reason", "errors"], "planningResult");
    if (row["type"] !== "result") throw new Error("envelope");
    if (row["is_error"] === true) {
      const errors = row["errors"];
      if (!Array.isArray(errors) || errors.length > 8 || errors.some((item) => typeof item !== "string" || item.length > 4_000)) throw new Error("errors");
      const text = errors.join(" ");
      const code: ProviderErrorCode = /rate.?limit|too many requests|\b429\b/iu.test(text) ? "RATE_LIMITED"
        : /quota|usage limit|allowance/iu.test(text) ? "QUOTA_EXCEEDED"
          : /authentication|not logged in|unauthorized/iu.test(text) ? "AUTHENTICATION_FAILED" : "CONTENT_REJECTED";
      throw failure(code, "The planning provider refused the request. No automatic retry or alternate route is permitted.");
    }
    if (row["is_error"] !== false || row["subtype"] !== "success" || row["num_turns"] !== 1 ||
      !Array.isArray(row["permission_denials"]) || row["permission_denials"].length !== 0 ||
      (row["errors"] !== undefined && (!Array.isArray(row["errors"]) || row["errors"].length !== 0)) ||
      (row["stop_reason"] !== undefined && row["stop_reason"] !== null && row["stop_reason"] !== "end_turn")) throw new Error("terminal");
    for (const key of ["duration_ms", "duration_api_ms"]) if (row[key] !== undefined) ensureSafeInteger(row[key], key, 0, PLANNING_MAX_DEADLINE_MS);
    for (const key of ["session_id", "uuid"]) if (row[key] !== undefined) ensureString(row[key], key, { maxLength: 128 });
    if (row["result"] !== undefined) ensureString(row["result"], "result", { minLength: 0, maxLength: 262_144 });
    const usage = ensureRecord(row["usage"], "usage");
    ensureExactKeys(usage, ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "server_tool_use", "service_tier", "cache_creation"], "usage");
    const count = (source: Record<string, unknown>, key: string) => ensureSafeInteger(source[key], key, 0, 1_000_000_000);
    const inputTokens = count(usage, "input_tokens");
    const outputTokens = count(usage, "output_tokens");
    const cacheCreation = count(usage, "cache_creation_input_tokens");
    const cachedInput = count(usage, "cache_read_input_tokens");
    if (outputTokens > binding.maxOutputTokens) throw new Error("output-tokens");
    if (usage["server_tool_use"] !== undefined) {
      const tools = ensureRecord(usage["server_tool_use"], "server_tool_use");
      ensureExactKeys(tools, ["web_search_requests", "web_fetch_requests"], "server_tool_use");
      if (Object.values(tools).some((value) => value !== 0)) throw new Error("tools");
    }
    if (usage["service_tier"] !== undefined) ensureString(usage["service_tier"], "service_tier", { maxLength: 64 });
    if (usage["cache_creation"] !== undefined) {
      const cache = ensureRecord(usage["cache_creation"], "cache_creation");
      ensureExactKeys(cache, ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"], "cache_creation");
      if (count(cache, "ephemeral_1h_input_tokens") + count(cache, "ephemeral_5m_input_tokens") !== cacheCreation) throw new Error("cache");
    }
    const models = ensureRecord(row["modelUsage"], "modelUsage");
    if (Object.keys(models).length !== 1 || !Object.hasOwn(models, binding.modelId)) throw new Error("model");
    const model = ensureRecord(models[binding.modelId], "modelUsage.model");
    ensureExactKeys(model, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "webSearchRequests", "costUSD", "contextWindow", "maxOutputTokens"], "modelUsage.model");
    if (count(model, "inputTokens") !== inputTokens || count(model, "outputTokens") !== outputTokens ||
      count(model, "cacheReadInputTokens") !== cachedInput || count(model, "cacheCreationInputTokens") !== cacheCreation ||
      (model["webSearchRequests"] !== undefined && model["webSearchRequests"] !== 0)) throw new Error("model-usage");
    for (const key of ["contextWindow", "maxOutputTokens"]) if (model[key] !== undefined) count(model, key);
    const cost = (value: unknown): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error("cost");
      return value;
    };
    const equivalent = cost(row["total_cost_usd"]);
    const modelCost = cost(model["costUSD"]);
    if (equivalent !== null && modelCost !== null && Math.abs(equivalent - modelCost) > 0.000001) throw new Error("cost-mismatch");
    return Object.freeze({
      structuredOutput: validatePlanningStructuredOutput(row["structured_output"], schema),
      usage: Object.freeze({ state: "reported", value: parseProviderUsage({ tokens: { inputTokens: inputTokens + cacheCreation, outputTokens, cachedInputTokens: cachedInput, reasoningTokens: 0 }, toolCalls: 0 }), subscriptionEquivalentUsd: equivalent }),
    });
  } catch (error) {
    if (error instanceof ProviderError && ["RATE_LIMITED", "QUOTA_EXCEEDED", "AUTHENTICATION_FAILED", "CONTENT_REJECTED"].includes(error.code)) throw error;
    throw failure("MALFORMED_RESPONSE", "The planning output failed exact protocol, model, usage or schema validation.");
  }
}

function checkedRoute(host: PlanningProcessPort, binding: PlanningRequestBinding, clock: Clock): Extract<PlanningRouteStatus, { state: "qualified" }> {
  const status = host.status();
  if (status.state !== "qualified") throw failure("POLICY_DENIED", "The subscription planning route is not qualified; no inference can launch.");
  const model = parseModelDescriptor(status.model);
  if (!["owned-subscription", "synthetic-fixture"].includes(status.source) || status.protocol !== CLAUDE_PLANNING_PROTOCOL ||
    status.subscriptionAllowance !== "unknown" || status.qualificationFingerprint !== binding.qualificationFingerprint ||
    status.configurationFingerprint !== binding.configurationFingerprint || parseDeadline(status.expiresAt) <= clock.now().toISOString() ||
    model.availability !== "available" || model.model.providerId !== CLAUDE_PLANNING_PROVIDER_ID || model.model.modelId !== binding.modelId ||
    !model.model.supportsStructuredOutput || model.model.supportsToolUse || model.model.supportsVision ||
    model.model.maxOutputTokens < binding.maxOutputTokens || model.model.locality !== "cloud" ||
    typeof status.disclosure?.retainsData !== "boolean" || typeof status.disclosure?.trainsOnInputs !== "boolean" ||
    !Array.isArray(status.disclosure?.supportedClassifications) || status.disclosure.supportedClassifications.length === 0 ||
    status.disclosure.supportedClassifications.some((item) => !["public", "internal"].includes(item))) {
    throw failure("POLICY_DENIED", "The planning model or qualified configuration changed before invocation.");
  }
  return status;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal, deadline: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(failure(deadline() ? "DEADLINE_EXCEEDED" : "CANCELLED", "The bounded planning operation stopped; provider usage may be unknown."));
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createClaudePlanningInferenceProvider(options: {
  readonly host: PlanningProcessPort;
  readonly binding: PlanningRequestBinding;
  readonly clock?: Clock;
  readonly observer?: (event: PlanningInferenceObservation) => void;
}): ClaudePlanningInferenceProvider {
  const binding = parsePlanningRequestBinding(options.binding);
  const clock = options.clock ?? systemClock;
  const host = options.host;
  let initial: Extract<PlanningRouteStatus, { state: "qualified" }> | null = null;
  try { initial = checkedRoute(host, binding, clock); } catch { /* No capability claimed from unqualified metadata. */ }
  const initialRouteFingerprint = initial === null ? null : planningInferenceFingerprint(initial);
  const currentRoute = () => {
    const route = checkedRoute(host, binding, clock);
    // Bind every qualified practice and model field, even if a host accidentally
    // reuses its configuration/qualification identifiers after metadata changes.
    if (initialRouteFingerprint === null || planningInferenceFingerprint(route) !== initialRouteFingerprint) {
      throw failure("POLICY_DENIED", "The exact planning route changed after its admission subject was prepared.");
    }
    return route;
  };
  const descriptor = parseProviderDescriptor({
    schemaVersion: 1, providerId: CLAUDE_PLANNING_PROVIDER_ID, instanceId: binding.instanceId,
    kind: "inference", displayName: "Claude Code subscription planning", locality: "cloud",
    // Unknown practices remain conservative; only the trusted host qualification
    // can supply the explicit practices used in disclosure-policy evaluation.
    retainsData: initial?.disclosure.retainsData ?? true, trainsOnInputs: initial?.disclosure.trainsOnInputs ?? true,
    supportedClassifications: initial?.disclosure.supportedClassifications ?? ["public"],
    capabilities: { streaming: false, structuredOutput: initial !== null, toolCalling: false,
      imageInput: false, repositoryEditing: false, commandExecution: false, networkAccess: false,
      resumability: false, cancellation: "best-effort", deadlineEnforcement: true,
      usageReporting: true, pricingAvailable: false },
  });
  let closed = false;
  let used = false;
  const active = new Set<AbortController>();
  const pumps = new Set<Promise<void>>();
  const observe = (event: PlanningInferenceObservation) => { try { options.observer?.(Object.freeze(event)); } catch { /* Not an authority or durable outcome recorder. */ } };
  return Object.freeze({
    kind: "inference" as const,
    describe: () => descriptor,
    routeStatus: () => host.status(),
    async listModels(): Promise<readonly ModelDescriptor[]> {
      if (closed || host.status().state !== "qualified") return Object.freeze([]);
      return Object.freeze([parseModelDescriptor(currentRoute().model)]);
    },
    async health() {
      let ready = false;
      try { currentRoute(); ready = true; } catch { /* Effect-free refusal. */ }
      return Object.freeze({ status: closed ? "closed" as const : ready ? "ready" as const : "unavailable" as const,
        checkedAt: clock.now().toISOString(), detailCode: ready ? null : "route-unqualified", activeOperations: active.size });
    },
    async start(raw: InferenceRequest, startOptions: StartOperationOptions = {}): Promise<InferenceOperation> {
      if (closed) throw failure("PROVIDER_CLOSED", "The planning provider is closed.");
      if (used) throw failure("POLICY_DENIED", "This exact planning request has already been initiated; it cannot dispatch again.");
      const request = checkedRequest(raw, binding);
      const invocation = buildPlanningInvocation(request, binding);
      currentRoute();
      const remaining = Date.parse(binding.deadline) - clock.now().valueOf();
      if (remaining <= 0 || remaining > PLANNING_MAX_DEADLINE_MS) throw failure("DEADLINE_EXCEEDED", "The planning request has no current finite deadline.");
      if (!descriptor.supportedClassifications.includes(request.disclosure.classification) ||
        !["public", "internal"].includes(request.disclosure.classification) || request.disclosure.requiredLocality === "local-only" ||
        (request.disclosure.classification === "internal" && descriptor.trainsOnInputs)) throw failure("POLICY_DENIED", "This development route permits only the explicitly reviewed project information under its qualified disclosure policy.");
      if (startOptions.signal?.aborted === true) throw failure("CANCELLED", "The planning request was cancelled before admission.");
      used = true;
      const abort = new AbortController();
      let deadlineFired = false;
      const timer = setTimeout(() => { deadlineFired = true; abort.abort(); }, remaining);
      timer.unref?.();
      startOptions.signal?.addEventListener("abort", () => abort.abort(), { once: true });
      active.add(abort);
      const fingerprint = planningInferenceFingerprint(request);
      let admission: PlanningAdmission;
      try {
        admission = await bounded(host.authorize(binding, fingerprint), abort.signal, () => deadlineFired);
      } catch (error) {
        clearTimeout(timer); active.delete(abort);
        throw error instanceof ProviderError ? error : failure("POLICY_DENIED", "The host refused planning admission.");
      }
      const operationId = parseProviderOperationId(`planning-${randomUUID()}`);
      const controller = createOperationController<InferenceEvent, InferenceResult>({
        operationId, clock, trace: request.trace,
        buildCancelledEvent: (base, reason) => ({ ...base, kind: "operation-cancelled", payload: { reason } }),
      });
      controller.onCancel(() => abort.abort());
      controller.emit((base) => ({ ...base, kind: "operation-started", payload: { modelId: binding.modelId } }));
      const started = clock.now().valueOf();
      const pump = (async () => {
        let dispatched = false;
        let usage: PlanningUsageObservation = unknownUsage;
        let terminationConfirmed = false;
        try {
          await bounded(Promise.resolve(host.assertCurrent(admission, binding, fingerprint)), abort.signal, () => deadlineFired);
          currentRoute();
          const admissionExpired = Date.parse(binding.deadline) <= clock.now().valueOf();
          if (closed || abort.signal.aborted || admissionExpired) throw failure(deadlineFired || admissionExpired ? "DEADLINE_EXCEEDED" : "CANCELLED", "Planning admission ended before launch.");
          // The port must commit durable dispatch and recheck its capability
          // before any effect. A thrown/missing reply here remains ambiguous.
          dispatched = true;
          observe({ requestId: binding.requestId, requestFingerprint: fingerprint, state: "dispatched", code: null, usage, terminationConfirmed: false });
          const result = await bounded(host.execute({ admission, binding, requestFingerprint: fingerprint, invocation, signal: abort.signal }), abort.signal, () => deadlineFired);
          terminationConfirmed = result.terminationConfirmed;
          if (result.state !== "exited" || !result.terminationConfirmed) throw failure(result.state === "deadline" ? "DEADLINE_EXCEEDED" : result.state === "cancelled" ? "CANCELLED" : "PROTOCOL_VIOLATION", "The planning process did not report a confirmed terminal exit.");
          if (result.truncated || !Number.isSafeInteger(result.stderrBytes) || result.stderrBytes < 0 || result.stdout.byteLength + result.stderrBytes > binding.maxOutputBytes) throw failure("MALFORMED_RESPONSE", "The planning output exceeded its bound or was truncated.");
          const parsed = parsePlanningPrintResult(result.stdout, binding, request.structuredOutput!.schema);
          usage = parsed.usage;
          if (result.exitCode !== 0) throw failure("PROTOCOL_VIOLATION", "The planning process contradicted its terminal result.");
          if (deadlineFired || Date.parse(binding.deadline) <= clock.now().valueOf()) throw failure("DEADLINE_EXCEEDED", "A planning result received after its deadline cannot be accepted.");
          if (controller.isTerminal || abort.signal.aborted || closed) throw failure("CANCELLED", "A late planning result cannot replace a stopped operation.");
          const final = parseInferenceResult({ schemaVersion: 1, operationId, requestId: request.requestId, modelId: binding.modelId,
            messages: [], structuredOutput: parsed.structuredOutput, finishReason: "stop", refusalMessage: null,
            usage: parsed.usage.value, cost: UNKNOWN_COST,
            latency: { firstEventMs: null, totalMs: Math.max(0, clock.now().valueOf() - started) }, warnings: [] });
          controller.emit((base) => ({ ...base, kind: "structured-output-completed", payload: { value: parsed.structuredOutput } }));
          controller.emit((base) => ({ ...base, kind: "usage-update", payload: { usage: parsed.usage.value } }));
          controller.complete((base) => ({ ...base, kind: "operation-completed", payload: {} }), final);
          observe({ requestId: binding.requestId, requestFingerprint: fingerprint, state: "succeeded", code: null, usage, terminationConfirmed });
        } catch (error) {
          const known = error instanceof ProviderError ? error : failure("PROTOCOL_VIOLATION", "The planning host did not return a valid outcome.");
          if (!controller.isTerminal) controller.fail((base) => ({ ...base, kind: "operation-failed", payload: { code: known.code, message: known.message, retryStrategy: "human-action" } }), known);
          observe({ requestId: binding.requestId, requestFingerprint: fingerprint, state: known.code === "CANCELLED" ? "cancelled" : "failed", code: known.code, usage, terminationConfirmed: dispatched ? terminationConfirmed : true });
        } finally {
          clearTimeout(timer); active.delete(abort);
        }
      })();
      pumps.add(pump);
      void pump.finally(() => pumps.delete(pump)).catch(() => undefined);
      return guardProviderOperation(controller.operation, { parseEvent: parseInferenceEvent, parseResult: parseInferenceResult });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const operation of active) operation.abort();
      await Promise.allSettled([...pumps]);
    },
  });
}

/** Structural ThinkerInferencePort implementation. It carries no fabricated
 * API SecretRef, catalog entry, remaining allowance or routing fallback. */
export interface PlanningThinkerInstance {
  readonly instanceId: string;
  readonly contractModelId: string;
  readonly descriptor: ProviderDescriptor;
  readonly model: ModelDescriptor;
  readonly userPreference: "enabled";
  readonly fingerprint: string;
}

export interface PlanningThinkerPort {
  fingerprint(): string;
  getInstance(instanceId: string): PlanningThinkerInstance | undefined;
  preflight(input: { readonly instanceId: string; readonly request: InferenceRequest }): {
    readonly instance: PlanningThinkerInstance; readonly request: InferenceRequest;
  };
  invoke(input: { readonly instanceId: string; readonly request: InferenceRequest; readonly options?: StartOperationOptions }): Promise<InferenceOperation>;
}

export async function createPlanningThinkerPort(provider: ClaudePlanningInferenceProvider): Promise<PlanningThinkerPort> {
  const descriptor = parseProviderDescriptor(provider.describe());
  const route = provider.routeStatus();
  if (provider.kind !== "inference" || descriptor.kind !== "inference" || route.state !== "qualified") throw failure("POLICY_DENIED", "No qualified inference target is available for planning.");
  const models = await provider.listModels();
  if (models.length !== 1) throw failure("MODEL_UNAVAILABLE", "The planning target must name one exact model.");
  const model = parseModelDescriptor(models[0]);
  const routeFingerprint = planningInferenceFingerprint(route);
  const base = { instanceId: descriptor.instanceId as string, contractModelId: model.model.modelId as string,
    descriptor, model, userPreference: "enabled" as const };
  const instance = Object.freeze({ ...base, fingerprint: planningInferenceFingerprint({ ...base, routeFingerprint }) });
  const fingerprint = planningInferenceFingerprint({ kind: "development-planning", instanceFingerprint: instance.fingerprint });
  const current = () => {
    if (planningInferenceFingerprint(provider.routeStatus()) !== routeFingerprint) throw failure("POLICY_DENIED", "The planning qualification changed after target selection.");
  };
  const preflight = (input: { readonly instanceId: string; readonly request: InferenceRequest }) => {
    current();
    const request = parseInferenceRequest(input.request);
    if (input.instanceId !== instance.instanceId || request.modelId !== instance.contractModelId) throw failure("MODEL_UNAVAILABLE", "The planning request selected a different target.");
    return Object.freeze({ instance, request });
  };
  return Object.freeze({ fingerprint: () => fingerprint,
    getInstance(instanceId: string) { current(); return instanceId === instance.instanceId ? instance : undefined; },
    preflight,
    async invoke(input: Parameters<PlanningThinkerPort["invoke"]>[0]) { const checked = preflight(input); return provider.start(checked.request, input.options); },
  });
}

/** Fixed argv, prepared only from typed validated input. These flags are defence
 * in depth and explicitly do not qualify managed-policy isolation. */
export function buildPlanningInvocation(raw: InferenceRequest, rawBinding: PlanningRequestBinding): PlanningInvocation {
  const binding = parsePlanningRequestBinding(rawBinding);
  const request = checkedRequest(raw, binding);
  const textOf = (index: number) => (request.messages[index]!.parts[0] as { readonly type: "text"; readonly text: string }).text;
  const stdin = Buffer.from(textOf(request.messages.length - 1), "utf8");
  // Claude print mode has one system-prompt channel. Only the compiler's
  // trusted system/developer prefix is installed there; project/user content
  // remains exclusively on stdin, preserving the actual message boundary.
  const systemText = request.messages.slice(0, -1).map((message, index) => `${message.role.toUpperCase()} INSTRUCTIONS\n${textOf(index)}`).join("\n\n");
  const systemBytes = Buffer.byteLength(systemText, "utf8");
  if (systemBytes > 8_192 || stdin.byteLength + systemBytes > binding.maxInputBytes) throw failure("INVALID_REQUEST", "The planning input exceeds its approved byte bound.");
  const args = [
    "--print", "--output-format", "json", "--json-schema", toCanonicalJson(request.structuredOutput!.schema),
    "--model", binding.modelId, "--max-turns", "1", "--tools", "", "--safe-mode",
    "--setting-sources", "", "--no-chrome", "--disable-slash-commands",
    "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--no-session-persistence",
    // Even the single-user request replaces the coding-oriented ambient
    // system prompt with an empty string instead of inheriting it.
    "--system-prompt", systemText,
  ];
  if (Buffer.byteLength(toCanonicalJson(args), "utf8") > 24_576) throw failure("INVALID_REQUEST", "The planning protocol arguments exceed the fixed bound.");
  return Object.freeze({
    protocol: CLAUDE_PLANNING_PROTOCOL,
    args: Object.freeze(args),
    stdin: new Uint8Array(stdin), maxOutputBytes: binding.maxOutputBytes, deadline: binding.deadline,
  });
}
