/**
 * Locked provider control-plane egress requirements.
 *
 * This contract describes exact destinations; it does not open a socket or
 * authorize workload networking. A trusted relay/backend must separately bind
 * and enforce the fingerprint. No provider domains are inferred or built in.
 */

import { isIP } from "node:net";
import { validation } from "@ai-dev-os/domain";
import { invalidConfiguration } from "./errors.js";
import { fingerprintOf } from "./fingerprint.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
  ensureTimestamp,
} = validation;

export const CONTROL_PLANE_ENDPOINT_POLICY_SCHEMA_VERSION = 1 as const;
export const CONTROL_PLANE_ENDPOINT_POLICY_ALGORITHM_VERSION = 1 as const;
export const MAX_CONTROL_PLANE_ENDPOINT_POLICY_VALIDITY_MS = 86_400_000;

export const CONTROL_PLANE_PURPOSES = Object.freeze([
  "claude-code-control",
  "codex-control",
] as const);
export type ControlPlanePurpose = (typeof CONTROL_PLANE_PURPOSES)[number];

export interface ControlPlaneEndpoint {
  readonly scheme: "https";
  readonly host: string;
  readonly port: 443;
  readonly purpose: ControlPlanePurpose;
}

export interface ControlPlaneEndpointPolicyUnsigned {
  readonly schemaVersion: typeof CONTROL_PLANE_ENDPOINT_POLICY_SCHEMA_VERSION;
  readonly algorithmVersion: typeof CONTROL_PLANE_ENDPOINT_POLICY_ALGORITHM_VERSION;
  readonly policyId: string;
  readonly providerInstanceId: string;
  readonly adapterProfileId: string;
  readonly toolId: string;
  readonly endpoints: readonly ControlPlaneEndpoint[];
  readonly dnsPolicyVersion: 1;
  readonly maxRedirectHops: number;
  readonly allowHttp2: boolean;
  readonly allowHttp3: false;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface ControlPlaneEndpointPolicy extends ControlPlaneEndpointPolicyUnsigned {
  readonly fingerprint: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function identifier(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID_PATTERN,
    patternName: "identifier",
  });
}

function parseEndpoint(value: unknown, path: string): ControlPlaneEndpoint {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["scheme", "host", "port", "purpose"], path);
  const host = ensureString(record["host"], `${path}.host`, { maxLength: 253 });
  if (
    host !== host.toLowerCase() ||
    host.endsWith(".") ||
    !HOST_PATTERN.test(host) ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw invalidConfiguration(
      "A control-plane endpoint must be an exact lowercase public DNS name.",
      { field: `${path}.host` },
    );
  }
  const port = ensureSafeInteger(record["port"], `${path}.port`, 443, 443);
  return Object.freeze({
    scheme: ensureEnum(record["scheme"], `${path}.scheme`, ["https"] as const),
    host,
    port: port as 443,
    purpose: ensureEnum(
      record["purpose"],
      `${path}.purpose`,
      CONTROL_PLANE_PURPOSES,
    ),
  });
}

export function controlPlaneEndpointPolicyFingerprint(
  value: ControlPlaneEndpointPolicyUnsigned,
): string {
  return fingerprintOf(value);
}

export function parseControlPlaneEndpointPolicy(
  value: unknown,
  path = "controlPlaneEndpointPolicy",
): ControlPlaneEndpointPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "algorithmVersion",
      "policyId",
      "providerInstanceId",
      "adapterProfileId",
      "toolId",
      "endpoints",
      "dnsPolicyVersion",
      "maxRedirectHops",
      "allowHttp2",
      "allowHttp3",
      "observedAt",
      "expiresAt",
      "fingerprint",
    ],
    path,
  );
  validation.ensureSchemaVersion(
    record["schemaVersion"],
    `${path}.schemaVersion`,
    CONTROL_PLANE_ENDPOINT_POLICY_SCHEMA_VERSION,
  );
  validation.ensureSchemaVersion(
    record["algorithmVersion"],
    `${path}.algorithmVersion`,
    CONTROL_PLANE_ENDPOINT_POLICY_ALGORITHM_VERSION,
  );
  validation.ensureSchemaVersion(
    record["dnsPolicyVersion"],
    `${path}.dnsPolicyVersion`,
    1,
  );
  const endpoints = ensureArray(record["endpoints"], `${path}.endpoints`, 32).map(
    (entry, index) => parseEndpoint(entry, `${path}.endpoints[${index}]`),
  );
  if (endpoints.length === 0) {
    throw invalidConfiguration("A control-plane endpoint policy cannot be empty.");
  }
  const endpointKeys = endpoints.map(
    (endpoint) => `${endpoint.scheme}:${endpoint.host}:${endpoint.port}:${endpoint.purpose}`,
  );
  if (new Set(endpointKeys).size !== endpointKeys.length) {
    throw invalidConfiguration("A control-plane endpoint policy contains duplicates.");
  }
  const observedAt = ensureTimestamp(record["observedAt"], `${path}.observedAt`);
  const expiresAt = ensureTimestamp(record["expiresAt"], `${path}.expiresAt`);
  const validityMs = new Date(expiresAt).valueOf() - new Date(observedAt).valueOf();
  if (validityMs <= 0) {
    throw invalidConfiguration("A control-plane endpoint policy must expire after observation.");
  }
  if (validityMs > MAX_CONTROL_PLANE_ENDPOINT_POLICY_VALIDITY_MS) {
    throw invalidConfiguration("A control-plane endpoint policy exceeds its validity window.");
  }
  const allowHttp3 = ensureBoolean(record["allowHttp3"], `${path}.allowHttp3`);
  if (allowHttp3) {
    throw invalidConfiguration("HTTP/3 and QUIC are not permitted by this policy version.");
  }
  const unsigned: ControlPlaneEndpointPolicyUnsigned = Object.freeze({
    schemaVersion: CONTROL_PLANE_ENDPOINT_POLICY_SCHEMA_VERSION,
    algorithmVersion: CONTROL_PLANE_ENDPOINT_POLICY_ALGORITHM_VERSION,
    policyId: identifier(record["policyId"], `${path}.policyId`),
    providerInstanceId: identifier(
      record["providerInstanceId"],
      `${path}.providerInstanceId`,
    ),
    adapterProfileId: identifier(record["adapterProfileId"], `${path}.adapterProfileId`),
    toolId: ensureString(record["toolId"], `${path}.toolId`, {
      maxLength: 64,
      pattern: TOOL_PATTERN,
      patternName: "tool identifier",
    }),
    endpoints: Object.freeze(
      [...endpoints].sort((left, right) => {
        const leftKey = `${left.purpose}:${left.host}`;
        const rightKey = `${right.purpose}:${right.host}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    ),
    dnsPolicyVersion: 1 as const,
    maxRedirectHops: ensureSafeInteger(
      record["maxRedirectHops"],
      `${path}.maxRedirectHops`,
      0,
      5,
    ),
    allowHttp2: ensureBoolean(record["allowHttp2"], `${path}.allowHttp2`),
    allowHttp3: false as const,
    observedAt,
    expiresAt,
  });
  const fingerprint = ensureString(record["fingerprint"], `${path}.fingerprint`, {
    minLength: 64,
    maxLength: 64,
    pattern: DIGEST_PATTERN,
    patternName: "sha-256 digest",
  });
  if (controlPlaneEndpointPolicyFingerprint(unsigned) !== fingerprint) {
    throw invalidConfiguration("The control-plane endpoint policy fingerprint does not match.");
  }
  return Object.freeze({ ...unsigned, fingerprint });
}

export function createControlPlaneEndpointPolicy(
  input: ControlPlaneEndpointPolicyUnsigned,
): ControlPlaneEndpointPolicy {
  return parseControlPlaneEndpointPolicy({
    ...input,
    fingerprint: controlPlaneEndpointPolicyFingerprint(input),
  });
}
