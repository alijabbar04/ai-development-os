import { parseCompiledThinkerPrompt, type CompiledThinkerPrompt } from "@ai-dev-os/prompt-compiler";
import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import {
  ESTIMATOR_ACCURACY_CLASSES,
  type EstimatorAccuracyClass
} from "./config.js";
import {
  HEX_64,
  SAFE_ID,
  SAFE_KIND,
  ceilRatio,
  checkedNumber,
  compareText,
  digest
} from "./shared.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSafeInteger,
  ensureSchemaVersion,
  ensureString,
  fail
} = validation;

function safeCount(value: unknown, path: string, minimum = 0): number {
  return ensureSafeInteger(value, path, minimum, Number.MAX_SAFE_INTEGER);
}

export const TOKEN_ESTIMATOR_CONTRACT_VERSION = 1 as const;
export const TOKEN_ESTIMATE_SCHEMA_VERSION = 1 as const;
export const TOKENIZER_EVIDENCE_KINDS = Object.freeze([
  "tokenizer-and-complete-framing",
  "declared-conservative-bound",
  "heuristic-ratio"
] as const);
export type TokenizerEvidenceKind = (typeof TOKENIZER_EVIDENCE_KINDS)[number];

export interface TokenEstimatorApplicability {
  readonly providerId: string;
  readonly transportProfileId: string;
  readonly contractModelId: string;
  readonly catalogModelFingerprint: string;
}

export interface TokenEstimatorEvidence {
  readonly kind: TokenizerEvidenceKind;
  readonly referenceFingerprint: string;
  readonly specificationVersion: string;
  readonly framingComplete: boolean;
}

export interface TokenEstimatorCountInput {
  readonly compiledPrompt: CompiledThinkerPrompt;
  readonly toolDefinitionBytes: number;
  readonly imageMetadataBytes: number;
  readonly artifactMetadataBytes: number;
}

export interface TokenEstimatorRawCount {
  readonly messageTokens: number;
  readonly schemaTokens: number;
  readonly toolTokens: number;
  readonly imageTokens: number;
  readonly artifactTokens: number;
  readonly fixedOverheadTokens: number;
}

export interface TokenEstimatorPort {
  count(input: TokenEstimatorCountInput): TokenEstimatorRawCount | unknown;
}

export interface TokenEstimatorDescriptor {
  readonly schemaVersion: typeof TOKEN_ESTIMATOR_CONTRACT_VERSION;
  readonly estimatorId: string;
  readonly algorithmVersion: number;
  readonly applicability: TokenEstimatorApplicability;
  readonly accuracy: EstimatorAccuracyClass;
  readonly evidence: TokenEstimatorEvidence;
  readonly maximumInputBytes: number;
  readonly safetyMarginBps: number;
  readonly fingerprint: string;
  readonly port: TokenEstimatorPort;
}

export interface TokenEstimatorDescriptorMetadata extends Omit<TokenEstimatorDescriptor, "port"> {}

function descriptorFingerprint(value: Omit<TokenEstimatorDescriptorMetadata, "fingerprint">): string {
  return digest(value);
}

function parseApplicability(value: unknown, path: string): TokenEstimatorApplicability {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["providerId", "transportProfileId", "contractModelId", "catalogModelFingerprint"],
    path
  );
  return Object.freeze({
    providerId: ensureString(record["providerId"], `${path}.providerId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "provider identifier"
    }),
    transportProfileId: ensureString(record["transportProfileId"], `${path}.transportProfileId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "transport profile identifier"
    }),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    catalogModelFingerprint: ensureString(
      record["catalogModelFingerprint"],
      `${path}.catalogModelFingerprint`,
      { minLength: 64, maxLength: 64, pattern: HEX_64, patternName: "catalog fingerprint" }
    )
  });
}

function parseEvidence(value: unknown, path: string): TokenEstimatorEvidence {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["kind", "referenceFingerprint", "specificationVersion", "framingComplete"],
    path
  );
  return Object.freeze({
    kind: ensureEnum(record["kind"], `${path}.kind`, TOKENIZER_EVIDENCE_KINDS),
    referenceFingerprint: ensureString(
      record["referenceFingerprint"],
      `${path}.referenceFingerprint`,
      { minLength: 64, maxLength: 64, pattern: HEX_64, patternName: "evidence fingerprint" }
    ),
    specificationVersion: ensureString(
      record["specificationVersion"],
      `${path}.specificationVersion`,
      { minLength: 1, maxLength: 64, pattern: SAFE_ID, patternName: "specification version" }
    ),
    framingComplete: ensureBoolean(record["framingComplete"], `${path}.framingComplete`)
  });
}

export function validateTokenEstimator(
  value: TokenEstimatorDescriptor | unknown,
  path = "tokenEstimator"
): TokenEstimatorDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "estimatorId",
      "algorithmVersion",
      "applicability",
      "accuracy",
      "evidence",
      "maximumInputBytes",
      "safetyMarginBps",
      "fingerprint",
      "port"
    ],
    path
  );
  ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    TOKEN_ESTIMATOR_CONTRACT_VERSION
  );
  const accuracy = ensureEnum(record["accuracy"], `${path}.accuracy`, ESTIMATOR_ACCURACY_CLASSES);
  const evidence = parseEvidence(record["evidence"], `${path}.evidence`);
  if (
    accuracy === "exact" &&
    (evidence.kind !== "tokenizer-and-complete-framing" || !evidence.framingComplete)
  ) {
    fail(`${path}.accuracy`, "unproven_exactness", "exact estimators require complete framing evidence.");
  }
  if (accuracy === "proven-upper-bound" && evidence.kind === "heuristic-ratio") {
    fail(`${path}.accuracy`, "unproven_bound", "a heuristic ratio cannot claim a proven bound.");
  }
  const portValue = record["port"];
  if (
    typeof portValue !== "object" ||
    portValue === null ||
    !("count" in portValue) ||
    typeof (portValue as { readonly count?: unknown }).count !== "function"
  ) {
    fail(`${path}.port`, "invalid_port", "must expose a count function.");
  }
  const unsigned = Object.freeze({
    schemaVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    estimatorId: ensureString(record["estimatorId"], `${path}.estimatorId`, {
      minLength: 1,
      maxLength: 64,
      pattern: SAFE_KIND,
      patternName: "estimator identifier"
    }),
    algorithmVersion: ensureSafeInteger(
      record["algorithmVersion"],
      `${path}.algorithmVersion`,
      1,
      1_000_000
    ),
    applicability: parseApplicability(record["applicability"], `${path}.applicability`),
    accuracy,
    evidence,
    maximumInputBytes: ensureSafeInteger(
      record["maximumInputBytes"],
      `${path}.maximumInputBytes`,
      1,
      1_000_000_000_000
    ),
    safetyMarginBps: ensureSafeInteger(
      record["safetyMarginBps"],
      `${path}.safetyMarginBps`,
      0,
      100_000
    )
  });
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "estimator fingerprint"
  });
  if (descriptorFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match estimator metadata.");
  }
  return Object.freeze({
    ...unsigned,
    fingerprint,
    port: Object.freeze({ count: (portValue as TokenEstimatorPort).count.bind(portValue) })
  });
}

export function createTokenEstimatorDescriptor(input: {
  readonly estimatorId: string;
  readonly algorithmVersion: number;
  readonly applicability: TokenEstimatorApplicability;
  readonly accuracy: EstimatorAccuracyClass;
  readonly evidence: TokenEstimatorEvidence;
  readonly maximumInputBytes: number;
  readonly safetyMarginBps: number;
  readonly port: TokenEstimatorPort;
}): TokenEstimatorDescriptor {
  const unsigned = {
    schemaVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    estimatorId: input.estimatorId,
    algorithmVersion: input.algorithmVersion,
    applicability: input.applicability,
    accuracy: input.accuracy,
    evidence: input.evidence,
    maximumInputBytes: input.maximumInputBytes,
    safetyMarginBps: input.safetyMarginBps
  } as const;
  return validateTokenEstimator({
    ...unsigned,
    fingerprint: descriptorFingerprint(unsigned),
    port: input.port
  });
}

export interface TokenEstimationRequest {
  readonly compiledPrompt: CompiledThinkerPrompt;
  readonly toolDefinitionBytes: number;
  readonly imageMetadataBytes: number;
  readonly artifactMetadataBytes: number;
  readonly cachedInputTokens: number | null;
  readonly outputAllowanceTokens: number;
  readonly reasoningAllowanceTokens: number;
}

export interface TokenEstimateBreakdown {
  readonly messages: number;
  readonly schema: number;
  readonly tools: number;
  readonly images: number;
  readonly artifacts: number;
  readonly fixedFraming: number;
  readonly safetyMargin: number;
}

export interface TokenEstimate {
  readonly schemaVersion: typeof TOKEN_ESTIMATE_SCHEMA_VERSION;
  readonly contractVersion: typeof TOKEN_ESTIMATOR_CONTRACT_VERSION;
  readonly estimatorId: string;
  readonly estimatorFingerprint: string;
  readonly providerId: string;
  readonly transportProfileId: string;
  readonly contractModelId: string;
  readonly catalogModelFingerprint: string;
  readonly promptFingerprint: string;
  readonly accuracy: EstimatorAccuracyClass;
  readonly evidence: TokenEstimatorEvidence;
  readonly inputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly outputAllowanceTokens: number;
  readonly reasoningAllowanceTokens: number;
  readonly totalTokens: number;
  readonly contextContributionTokens: number;
  readonly canProveContextFit: boolean;
  readonly breakdown: TokenEstimateBreakdown;
  readonly fingerprint: string;
}

function parseRawCount(value: unknown, path: string): TokenEstimatorRawCount {
  const record = ensureRecord(value, path);
  const keys = [
    "messageTokens",
    "schemaTokens",
    "toolTokens",
    "imageTokens",
    "artifactTokens",
    "fixedOverheadTokens"
  ] as const;
  ensureExactKeys(record, keys, path);
  return Object.freeze({
    messageTokens: safeCount(record["messageTokens"], `${path}.messageTokens`),
    schemaTokens: safeCount(record["schemaTokens"], `${path}.schemaTokens`),
    toolTokens: safeCount(record["toolTokens"], `${path}.toolTokens`),
    imageTokens: safeCount(record["imageTokens"], `${path}.imageTokens`),
    artifactTokens: safeCount(record["artifactTokens"], `${path}.artifactTokens`),
    fixedOverheadTokens: safeCount(
      record["fixedOverheadTokens"],
      `${path}.fixedOverheadTokens`
    )
  });
}

function parseBreakdown(value: unknown, path: string): TokenEstimateBreakdown {
  const record = ensureRecord(value, path);
  const keys = ["messages", "schema", "tools", "images", "artifacts", "fixedFraming", "safetyMargin"] as const;
  ensureExactKeys(record, keys, path);
  return Object.freeze({
    messages: safeCount(record["messages"], `${path}.messages`),
    schema: safeCount(record["schema"], `${path}.schema`),
    tools: safeCount(record["tools"], `${path}.tools`),
    images: safeCount(record["images"], `${path}.images`),
    artifacts: safeCount(record["artifacts"], `${path}.artifacts`),
    fixedFraming: safeCount(record["fixedFraming"], `${path}.fixedFraming`),
    safetyMargin: safeCount(record["safetyMargin"], `${path}.safetyMargin`)
  });
}

export function tokenEstimateFingerprint(value: Omit<TokenEstimate, "fingerprint">): string {
  return digest(value);
}

export function parseTokenEstimate(value: unknown, path = "tokenEstimate"): TokenEstimate {
  const record = ensureRecord(value, path);
  const keys = [
    "schemaVersion",
    "contractVersion",
    "estimatorId",
    "estimatorFingerprint",
    "providerId",
    "transportProfileId",
    "contractModelId",
    "catalogModelFingerprint",
    "promptFingerprint",
    "accuracy",
    "evidence",
    "inputTokens",
    "cachedInputTokens",
    "outputAllowanceTokens",
    "reasoningAllowanceTokens",
    "totalTokens",
    "contextContributionTokens",
    "canProveContextFit",
    "breakdown",
    "fingerprint"
  ] as const;
  ensureExactKeys(record, keys, path);
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, TOKEN_ESTIMATE_SCHEMA_VERSION);
  ensureSchemaVersion(
    record["contractVersion"],
    `${path}.contractVersion`,
    TOKEN_ESTIMATOR_CONTRACT_VERSION
  );
  const hex = (key: "estimatorFingerprint" | "catalogModelFingerprint" | "promptFingerprint"): string =>
    ensureString(record[key], `${path}.${key}`, {
      minLength: 64,
      maxLength: 64,
      pattern: HEX_64,
      patternName: "fingerprint"
    });
  const unsigned = Object.freeze({
    schemaVersion: TOKEN_ESTIMATE_SCHEMA_VERSION,
    contractVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    estimatorId: ensureString(record["estimatorId"], `${path}.estimatorId`, {
      maxLength: 64,
      pattern: SAFE_KIND,
      patternName: "estimator identifier"
    }),
    estimatorFingerprint: hex("estimatorFingerprint"),
    providerId: ensureString(record["providerId"], `${path}.providerId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "provider identifier"
    }),
    transportProfileId: ensureString(record["transportProfileId"], `${path}.transportProfileId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "transport profile identifier"
    }),
    contractModelId: ensureString(record["contractModelId"], `${path}.contractModelId`, {
      maxLength: 128,
      pattern: SAFE_ID,
      patternName: "contract model identifier"
    }),
    catalogModelFingerprint: hex("catalogModelFingerprint"),
    promptFingerprint: hex("promptFingerprint"),
    accuracy: ensureEnum(record["accuracy"], `${path}.accuracy`, ESTIMATOR_ACCURACY_CLASSES),
    evidence: parseEvidence(record["evidence"], `${path}.evidence`),
    inputTokens: safeCount(record["inputTokens"], `${path}.inputTokens`),
    cachedInputTokens: ensureNullable(record["cachedInputTokens"], (raw) =>
      safeCount(raw, `${path}.cachedInputTokens`)
    ),
    outputAllowanceTokens: safeCount(
      record["outputAllowanceTokens"],
      `${path}.outputAllowanceTokens`
    ),
    reasoningAllowanceTokens: safeCount(
      record["reasoningAllowanceTokens"],
      `${path}.reasoningAllowanceTokens`
    ),
    totalTokens: safeCount(record["totalTokens"], `${path}.totalTokens`),
    contextContributionTokens: safeCount(
      record["contextContributionTokens"],
      `${path}.contextContributionTokens`
    ),
    canProveContextFit: ensureBoolean(
      record["canProveContextFit"],
      `${path}.canProveContextFit`
    ),
    breakdown: parseBreakdown(record["breakdown"], `${path}.breakdown`)
  });
  const calculatedInput = Object.values(unsigned.breakdown).reduce((total, item) => total + item, 0);
  if (!Number.isSafeInteger(calculatedInput) || calculatedInput !== unsigned.inputTokens) {
    fail(`${path}.inputTokens`, "accounting_mismatch", "must equal the complete overhead breakdown.");
  }
  const calculatedTotal =
    unsigned.inputTokens + unsigned.outputAllowanceTokens + unsigned.reasoningAllowanceTokens;
  if (!Number.isSafeInteger(calculatedTotal) || calculatedTotal !== unsigned.totalTokens) {
    fail(`${path}.totalTokens`, "accounting_mismatch", "must equal input plus output allowances.");
  }
  if (unsigned.contextContributionTokens !== calculatedTotal) {
    fail(`${path}.contextContributionTokens`, "accounting_mismatch", "must equal total tokens.");
  }
  if (unsigned.cachedInputTokens !== null && unsigned.cachedInputTokens > unsigned.inputTokens) {
    fail(`${path}.cachedInputTokens`, "cached_exceeds_input", "cannot exceed input tokens.");
  }
  if (unsigned.canProveContextFit !== (unsigned.accuracy !== "heuristic")) {
    fail(`${path}.canProveContextFit`, "accuracy_mismatch", "must reflect estimator accuracy.");
  }
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "token estimate fingerprint"
  });
  if (tokenEstimateFingerprint(unsigned) !== fingerprint) {
    fail(`${path}.fingerprint`, "fingerprint_mismatch", "does not match token estimate content.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

function parseEstimationRequest(value: TokenEstimationRequest): TokenEstimationRequest {
  const compiledPrompt = parseCompiledThinkerPrompt(value.compiledPrompt);
  return Object.freeze({
    compiledPrompt,
    toolDefinitionBytes: safeCount(value.toolDefinitionBytes, "estimate.toolDefinitionBytes"),
    imageMetadataBytes: safeCount(value.imageMetadataBytes, "estimate.imageMetadataBytes"),
    artifactMetadataBytes: safeCount(
      value.artifactMetadataBytes,
      "estimate.artifactMetadataBytes"
    ),
    cachedInputTokens: ensureNullable(value.cachedInputTokens, (raw) =>
      safeCount(raw, "estimate.cachedInputTokens")
    ),
    outputAllowanceTokens: safeCount(
      value.outputAllowanceTokens,
      "estimate.outputAllowanceTokens"
    ),
    reasoningAllowanceTokens: safeCount(
      value.reasoningAllowanceTokens,
      "estimate.reasoningAllowanceTokens"
    )
  });
}

function estimateWithDescriptor(
  descriptor: TokenEstimatorDescriptor,
  value: TokenEstimationRequest
): TokenEstimate {
  const request = parseEstimationRequest(value);
  const byteTotal =
    request.compiledPrompt.accounting.promptBytes +
    request.toolDefinitionBytes +
    request.imageMetadataBytes +
    request.artifactMetadataBytes;
  if (!Number.isSafeInteger(byteTotal) || byteTotal > descriptor.maximumInputBytes) {
    fail("estimate", "input_bound_exceeded", "estimator input exceeds its declared byte bound.");
  }
  let raw: unknown;
  try {
    raw = descriptor.port.count(
      Object.freeze({
        compiledPrompt: request.compiledPrompt,
        toolDefinitionBytes: request.toolDefinitionBytes,
        imageMetadataBytes: request.imageMetadataBytes,
        artifactMetadataBytes: request.artifactMetadataBytes
      })
    );
  } catch {
    fail("estimate", "estimator_failed", "token estimator port failed.");
  }
  const count = parseRawCount(raw, "estimate.count");
  const base = Object.values(count).reduce((total, item) => total + BigInt(item), 0n);
  const safetyMargin = checkedNumber(
    ceilRatio(base * BigInt(descriptor.safetyMarginBps), 10_000n, "token safety margin"),
    "token safety margin"
  );
  const breakdown = Object.freeze({
    messages: count.messageTokens,
    schema: count.schemaTokens,
    tools: count.toolTokens,
    images: count.imageTokens,
    artifacts: count.artifactTokens,
    fixedFraming: count.fixedOverheadTokens,
    safetyMargin
  });
  const inputTokens = checkedNumber(base + BigInt(safetyMargin), "input token estimate");
  if (request.cachedInputTokens !== null && request.cachedInputTokens > inputTokens) {
    fail("estimate.cachedInputTokens", "cached_exceeds_input", "cannot exceed estimated input.");
  }
  const totalTokens = checkedNumber(
    BigInt(inputTokens) +
      BigInt(request.outputAllowanceTokens) +
      BigInt(request.reasoningAllowanceTokens),
    "total token estimate"
  );
  const unsigned = Object.freeze({
    schemaVersion: TOKEN_ESTIMATE_SCHEMA_VERSION,
    contractVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    estimatorId: descriptor.estimatorId,
    estimatorFingerprint: descriptor.fingerprint,
    providerId: descriptor.applicability.providerId,
    transportProfileId: descriptor.applicability.transportProfileId,
    contractModelId: descriptor.applicability.contractModelId,
    catalogModelFingerprint: descriptor.applicability.catalogModelFingerprint,
    promptFingerprint: request.compiledPrompt.fingerprint,
    accuracy: descriptor.accuracy,
    evidence: descriptor.evidence,
    inputTokens,
    cachedInputTokens: request.cachedInputTokens,
    outputAllowanceTokens: request.outputAllowanceTokens,
    reasoningAllowanceTokens: request.reasoningAllowanceTokens,
    totalTokens,
    contextContributionTokens: totalTokens,
    canProveContextFit: descriptor.accuracy !== "heuristic",
    breakdown
  });
  return parseTokenEstimate({ ...unsigned, fingerprint: tokenEstimateFingerprint(unsigned) });
}

function bindingKey(value: TokenEstimatorApplicability): string {
  return toCanonicalJson(value);
}

export interface TokenEstimatorRegistry {
  readonly contractVersion: typeof TOKEN_ESTIMATOR_CONTRACT_VERSION;
  descriptors(): readonly TokenEstimatorDescriptorMetadata[];
  resolve(binding: TokenEstimatorApplicability): TokenEstimatorDescriptor | undefined;
  estimate(binding: TokenEstimatorApplicability, request: TokenEstimationRequest): TokenEstimate;
  fingerprint(): string;
}

export function createTokenEstimatorRegistry(
  values: readonly (TokenEstimatorDescriptor | unknown)[]
): TokenEstimatorRegistry {
  const descriptors = values.map((value, index) => validateTokenEstimator(value, `estimators[${index}]`));
  const byBinding = new Map<string, TokenEstimatorDescriptor>();
  for (const descriptor of descriptors) {
    const key = bindingKey(descriptor.applicability);
    if (byBinding.has(key)) fail("estimators", "duplicate_binding", "estimator bindings must be unique.");
    byBinding.set(key, descriptor);
  }
  descriptors.sort((left, right) => compareText(left.fingerprint, right.fingerprint));
  const metadata = Object.freeze(
    descriptors.map(({ port: _port, ...descriptor }) => Object.freeze(descriptor))
  );
  const registryFingerprint = digest({
    contractVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    descriptors: metadata
  });
  return Object.freeze({
    contractVersion: TOKEN_ESTIMATOR_CONTRACT_VERSION,
    descriptors: (): readonly TokenEstimatorDescriptorMetadata[] => metadata,
    resolve: (binding: TokenEstimatorApplicability): TokenEstimatorDescriptor | undefined =>
      byBinding.get(bindingKey(parseApplicability(binding, "binding"))),
    estimate: (binding: TokenEstimatorApplicability, request: TokenEstimationRequest): TokenEstimate => {
      const descriptor = byBinding.get(bindingKey(parseApplicability(binding, "binding")));
      if (descriptor === undefined) {
        fail("binding", "estimator_not_found", "no exact estimator binding exists.");
        throw new TypeError("Unreachable estimator lookup state.");
      }
      return estimateWithDescriptor(descriptor, request);
    },
    fingerprint: (): string => registryFingerprint
  });
}

export function estimateCompiledPromptTokens(
  registry: TokenEstimatorRegistry,
  binding: TokenEstimatorApplicability,
  request: TokenEstimationRequest
): TokenEstimate {
  return registry.estimate(binding, request);
}

export function createConservativeTokenEstimator(input: {
  readonly estimatorId: string;
  readonly applicability: TokenEstimatorApplicability;
  readonly accuracy: "proven-upper-bound" | "heuristic";
  readonly evidence: TokenEstimatorEvidence;
  readonly bytesPerTokenNumerator: number;
  readonly bytesPerTokenDenominator: number;
  readonly fixedOverheadTokens: number;
  readonly safetyMarginBps: number;
  readonly maximumInputBytes?: number;
}): TokenEstimatorDescriptor {
  const numerator = ensureSafeInteger(
    input.bytesPerTokenNumerator,
    "conservativeEstimator.bytesPerTokenNumerator",
    1,
    1_000_000
  );
  const denominator = ensureSafeInteger(
    input.bytesPerTokenDenominator,
    "conservativeEstimator.bytesPerTokenDenominator",
    1,
    1_000_000
  );
  const fixed = safeCount(
    input.fixedOverheadTokens,
    "conservativeEstimator.fixedOverheadTokens"
  );
  const countBytes = (bytes: number, label: string): number =>
    checkedNumber(
      ceilRatio(BigInt(bytes) * BigInt(numerator), BigInt(denominator), label),
      label
    );
  return createTokenEstimatorDescriptor({
    estimatorId: input.estimatorId,
    algorithmVersion: 1,
    applicability: input.applicability,
    accuracy: input.accuracy,
    evidence: input.evidence,
    maximumInputBytes: input.maximumInputBytes ?? 1_000_000_000,
    safetyMarginBps: input.safetyMarginBps,
    port: Object.freeze({
      count: (request: TokenEstimatorCountInput): TokenEstimatorRawCount => {
        const messageBytes =
          request.compiledPrompt.accounting.promptBytes -
          request.compiledPrompt.accounting.schemaBytes;
        return Object.freeze({
          messageTokens: countBytes(messageBytes, "message token estimate"),
          schemaTokens: countBytes(
            request.compiledPrompt.accounting.schemaBytes,
            "schema token estimate"
          ),
          toolTokens: countBytes(request.toolDefinitionBytes, "tool token estimate"),
          imageTokens: countBytes(request.imageMetadataBytes, "image token estimate"),
          artifactTokens: countBytes(request.artifactMetadataBytes, "artifact token estimate"),
          fixedOverheadTokens: fixed
        });
      }
    })
  });
}
