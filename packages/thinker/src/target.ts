import {
  parseApplicationConfiguration,
  type ApplicationConfiguration
} from "@ai-dev-os/config";
import { validation } from "@ai-dev-os/domain";
import {
  parsePromptTarget,
  sealPromptTarget,
  type PromptTargetSnapshot
} from "@ai-dev-os/prompt-compiler";
import type {
  GatewayInstanceSnapshot,
  GatewayPreflight,
  ProviderGateway
} from "@ai-dev-os/provider-gateway";
import {
  parseModelDescriptor,
  parseProviderDescriptor,
  type InferenceOperation,
  type InferenceRequest,
  type StartOperationOptions
} from "@ai-dev-os/providers";
import { ThinkerError, safeCauseCode } from "./errors.js";

const { ensureNullable, ensureString } = validation;
const HEX_64 = /^[0-9a-f]{64}$/u;
const ALIAS_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export interface ThinkerInferencePort {
  fingerprint(): string;
  getInstance(instanceId: string): GatewayInstanceSnapshot | undefined;
  preflight(input: {
    readonly instanceId: string;
    readonly request: InferenceRequest;
  }): GatewayPreflight;
  invoke(input: {
    readonly instanceId: string;
    readonly request: InferenceRequest;
    readonly options?: StartOperationOptions;
  }): Promise<InferenceOperation>;
}

export interface ResolvedThinkerTarget {
  readonly selectedAlias: string;
  readonly instanceId: string;
  readonly modelId: string;
  readonly targetFingerprint: string;
  readonly gatewayInstanceFingerprint: string;
  readonly gatewayFingerprint: string;
  readonly target: PromptTargetSnapshot;
}

export function createProviderGatewayThinkerPort(gateway: ProviderGateway): ThinkerInferencePort {
  return Object.freeze({
    fingerprint: () => gateway.fingerprint(),
    getInstance: (instanceId: string) => gateway.getInstance(instanceId),
    preflight: (input: { readonly instanceId: string; readonly request: InferenceRequest }) =>
      gateway.preflight(input),
    invoke: (input: {
      readonly instanceId: string;
      readonly request: InferenceRequest;
      readonly options?: StartOperationOptions;
    }) => gateway.invoke(input)
  });
}

function alias(value: unknown): string | null {
  return ensureNullable(value, (raw) =>
    ensureString(raw, "selectedAlias", {
      minLength: 1,
      maxLength: 64,
      pattern: ALIAS_PATTERN,
      patternName: "model alias"
    })
  );
}

function digest(value: unknown, path: string): string {
  return ensureString(value, path, {
    minLength: 64,
    maxLength: 64,
    pattern: HEX_64,
    patternName: "sha-256 digest"
  });
}

export function resolveThinkerTarget(input: {
  readonly configuration: unknown;
  readonly selectedAlias?: unknown;
  readonly port: ThinkerInferencePort;
  readonly expectedTarget: unknown;
}): ResolvedThinkerTarget {
  let configuration: ApplicationConfiguration;
  let selectedAlias: string | null;
  let expectedTarget: PromptTargetSnapshot;
  try {
    configuration = parseApplicationConfiguration(input.configuration);
    selectedAlias = alias(input.selectedAlias ?? null);
    expectedTarget = parsePromptTarget(input.expectedTarget);
  } catch (error) {
    throw new ThinkerError("INVALID_CONFIGURATION", "Thinker target configuration is invalid.", {
      causeCode: safeCauseCode(error)
    });
  }
  if (selectedAlias === null) {
    const planning = configuration.modelPreferences.find((item) => item.role === "planning");
    selectedAlias = planning?.aliases[0] ?? null;
  }
  if (selectedAlias === null) {
    throw new ThinkerError("TARGET_MISSING", "No planning target alias is configured.");
  }
  const selected = configuration.modelAliases.find((item) => item.alias === selectedAlias);
  if (selected === undefined) {
    throw new ThinkerError("TARGET_MISSING", "The selected planning alias is not configured.");
  }
  const providerConfiguration = configuration.providers.find(
    (item) => item.instanceId === selected.providerInstanceId
  );
  if (providerConfiguration === undefined) {
    throw new ThinkerError("TARGET_MISSING", "The selected provider instance is not configured.");
  }
  if (!providerConfiguration.enabled) {
    throw new ThinkerError("TARGET_DISABLED", "The selected provider instance is disabled.");
  }
  if (providerConfiguration.kind !== "inference") {
    throw new ThinkerError(
      "TARGET_WRONG_KIND",
      "A coding-agent provider cannot be used as an inference thinker."
    );
  }
  const rawSnapshot = input.port.getInstance(selected.providerInstanceId);
  if (rawSnapshot === undefined) {
    throw new ThinkerError("TARGET_MISSING", "The selected instance is absent from the gateway.");
  }
  let descriptor;
  let model;
  let instanceFingerprint: string;
  let gatewayFingerprint: string;
  try {
    descriptor = parseProviderDescriptor(rawSnapshot.descriptor, "gatewayInstance.descriptor");
    model = parseModelDescriptor(rawSnapshot.model, "gatewayInstance.model");
    instanceFingerprint = digest(rawSnapshot.fingerprint, "gatewayInstance.fingerprint");
    gatewayFingerprint = digest(input.port.fingerprint(), "gateway.fingerprint");
  } catch (error) {
    throw new ThinkerError("TARGET_MISMATCH", "The gateway target snapshot is malformed.", {
      causeCode: safeCauseCode(error)
    });
  }
  if (rawSnapshot.userPreference !== "enabled") {
    throw new ThinkerError("TARGET_DISABLED", "The selected gateway instance is disabled.");
  }
  if (
    rawSnapshot.instanceId !== selected.providerInstanceId ||
    descriptor.instanceId !== selected.providerInstanceId ||
    descriptor.providerId !== providerConfiguration.providerId ||
    descriptor.locality !== providerConfiguration.locality ||
    descriptor.kind !== "inference" ||
    rawSnapshot.contractModelId !== selected.modelId ||
    model.model.modelId !== selected.modelId ||
    model.model.providerId !== descriptor.providerId
  ) {
    throw new ThinkerError(
      "TARGET_MISMATCH",
      "The selected alias, configuration, gateway instance, and model do not match."
    );
  }
  if (model.availability !== "available") {
    throw new ThinkerError("TARGET_INELIGIBLE", "The selected model is not available.");
  }
  if (
    !descriptor.capabilities.structuredOutput ||
    !model.model.supportsStructuredOutput ||
    !descriptor.capabilities.deadlineEnforcement
  ) {
    throw new ThinkerError(
      "TARGET_INELIGIBLE",
      "The selected inference target lacks required structured-output or deadline capability."
    );
  }
  const target = sealPromptTarget({
    schemaVersion: expectedTarget.schemaVersion,
    instanceId: descriptor.instanceId,
    provider: descriptor,
    model: model.model
  });
  if (target.fingerprint !== expectedTarget.fingerprint) {
    throw new ThinkerError(
      "TARGET_MISMATCH",
      "The compilation request is bound to a different target snapshot."
    );
  }
  return Object.freeze({
    selectedAlias,
    instanceId: selected.providerInstanceId,
    modelId: selected.modelId,
    targetFingerprint: target.fingerprint,
    gatewayInstanceFingerprint: instanceFingerprint,
    gatewayFingerprint,
    target
  });
}
