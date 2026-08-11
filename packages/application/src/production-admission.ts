import { toCanonicalJson, validation } from "@ai-dev-os/domain";
import { computeChecksumOfText } from "@ai-dev-os/persistence";
import { ApplicationError } from "./errors.js";

const { ensureEnum, ensureExactKeys, ensureRecord, ensureString } = validation;

export const PRODUCTION_ADMISSION_SCHEMA_VERSION = 1 as const;
export const STAGE_18D_APPLICATION_PRODUCTION_ENABLED = false as const;

export const PRODUCTION_EFFECT_CLASSES = Object.freeze([
  "provider",
  "workspace",
  "git",
  "network",
  "native",
  "credential",
  "production-registration",
] as const);
export type ProductionEffectClass = (typeof PRODUCTION_EFFECT_CLASSES)[number];

export const PRODUCTION_ADMISSION_RULE_IDS = Object.freeze([
  "admission.request.invalid",
  "admission.stage18d.production-disabled",
  "admission.stage17.evidence-unavailable",
  "admission.effect.not-wired",
] as const);
export type ProductionAdmissionRuleId = (typeof PRODUCTION_ADMISSION_RULE_IDS)[number];

export interface ProductionAdmissionRequestV1 {
  readonly schemaVersion: 1;
  readonly effectClass: ProductionEffectClass;
  readonly workId?: string;
  readonly dispatchId?: string;
}

export interface ProductionAdmissionRefusalV1 {
  readonly schemaVersion: 1;
  readonly admitted: false;
  readonly productionEnabled: false;
  readonly grantsAuthority: false;
  readonly resumableByHumanApproval: false;
  readonly stage17Status: "safety-gated";
  readonly ruleIds: readonly ProductionAdmissionRuleId[];
  readonly reasons: readonly string[];
  readonly requestFingerprint: string | null;
}

export interface ProductionAdmissionGateV1 {
  readonly schemaVersion: 1;
  readonly productionEnabled: false;
  evaluate(input: unknown): ProductionAdmissionRefusalV1;
  assertAdmitted(input: unknown): never;
}

function parseOptionalId(value: unknown, path: string): string | undefined {
  return value === undefined
    ? undefined
    : ensureString(value, path, {
        maxLength: 128,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
        patternName: "identifier",
      });
}

function parseRequest(input: unknown): ProductionAdmissionRequestV1 {
  const record = ensureRecord(input, "productionAdmission");
  ensureExactKeys(
    record,
    ["schemaVersion", "effectClass", "workId", "dispatchId"],
    "productionAdmission",
  );
  if (record["schemaVersion"] !== PRODUCTION_ADMISSION_SCHEMA_VERSION) {
    throw new ApplicationError("INVALID_COMMAND", "The production-admission schema is unsupported.");
  }
  const workId = parseOptionalId(record["workId"], "productionAdmission.workId");
  const dispatchId = parseOptionalId(record["dispatchId"], "productionAdmission.dispatchId");
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMISSION_SCHEMA_VERSION,
    effectClass: ensureEnum(
      record["effectClass"],
      "productionAdmission.effectClass",
      PRODUCTION_EFFECT_CLASSES,
    ),
    ...(workId === undefined ? {} : { workId }),
    ...(dispatchId === undefined ? {} : { dispatchId }),
  });
}

function refusal(request: ProductionAdmissionRequestV1 | null): ProductionAdmissionRefusalV1 {
  const invalid = request === null;
  const ruleIds: readonly ProductionAdmissionRuleId[] = Object.freeze([
    ...(invalid ? ["admission.request.invalid" as const] : []),
    "admission.stage18d.production-disabled",
    "admission.stage17.evidence-unavailable",
    "admission.effect.not-wired",
  ]);
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMISSION_SCHEMA_VERSION,
    admitted: false,
    productionEnabled: STAGE_18D_APPLICATION_PRODUCTION_ENABLED,
    grantsAuthority: false,
    resumableByHumanApproval: false,
    stage17Status: "safety-gated",
    ruleIds,
    reasons: Object.freeze([
      ...(invalid ? ["The production-admission request is invalid."] : []),
      "Stage 18D is compiled production-disabled.",
      "The required Stage 17 production evidence is unavailable.",
      "No production effect boundary is wired in this checkpoint.",
    ]),
    requestFingerprint:
      request === null ? null : computeChecksumOfText(toCanonicalJson(request)).hex,
  });
}

export function createProductionAdmissionGate(): ProductionAdmissionGateV1 {
  const evaluate = (input: unknown): ProductionAdmissionRefusalV1 => {
    try {
      return refusal(parseRequest(input));
    } catch {
      return refusal(null);
    }
  };
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMISSION_SCHEMA_VERSION,
    productionEnabled: STAGE_18D_APPLICATION_PRODUCTION_ENABLED,
    evaluate,
    assertAdmitted(input: unknown): never {
      void evaluate(input);
      throw new ApplicationError("PRODUCTION_DISABLED", "Stage 18D production admission is closed.");
    },
  });
}
