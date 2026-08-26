import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  BEARER_TOKEN_PATTERN,
  CONTROL_DESCRIPTOR_SCHEMA_VERSION,
  CONTROL_HOST,
  MAX_SESSION_LIFETIME_MS,
  START_NONCE_PATTERN,
} from "./identity.js";
import { controlFail } from "./errors.js";
import { exactInteger, exactString, exactTimestamp, readExactRecord } from "./structural.js";

export interface ConnectionDescriptor {
  readonly schemaVersion: typeof CONTROL_DESCRIPTOR_SCHEMA_VERSION;
  readonly serviceVersion: string;
  readonly host: typeof CONTROL_HOST;
  readonly port: number;
  readonly processId: number;
  readonly startNonce: string;
  readonly bearerToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface InstanceLock {
  readonly schemaVersion: typeof CONTROL_DESCRIPTOR_SCHEMA_VERSION;
  readonly serviceVersion: string;
  readonly processId: number;
  readonly startNonce: string;
  readonly issuedAt: string;
}

const VERSION = /^\d+\.\d+\.\d+$/u;

export function parseConnectionDescriptor(value: unknown): ConnectionDescriptor {
  const record = readExactRecord(value, [
    "schemaVersion", "serviceVersion", "host", "port", "processId",
    "startNonce", "bearerToken", "issuedAt", "expiresAt",
  ]);
  if (record["schemaVersion"] !== CONTROL_DESCRIPTOR_SCHEMA_VERSION || record["host"] !== CONTROL_HOST) {
    controlFail("INVALID_INPUT");
  }
  const issuedAt = exactTimestamp(record["issuedAt"]);
  const expiresAt = exactTimestamp(record["expiresAt"]);
  const lifetime = new Date(expiresAt).valueOf() - new Date(issuedAt).valueOf();
  if (lifetime <= 0 || lifetime > MAX_SESSION_LIFETIME_MS) controlFail("INVALID_INPUT");
  return Object.freeze({
    schemaVersion: CONTROL_DESCRIPTOR_SCHEMA_VERSION,
    serviceVersion: exactString(record["serviceVersion"], VERSION, 32),
    host: CONTROL_HOST,
    port: exactInteger(record["port"], 1, 65_535),
    processId: exactInteger(record["processId"], 1, 2_147_483_647),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    bearerToken: exactString(record["bearerToken"], BEARER_TOKEN_PATTERN, 43),
    issuedAt,
    expiresAt,
  });
}

export function parseInstanceLock(value: unknown): InstanceLock {
  const record = readExactRecord(value, ["schemaVersion", "serviceVersion", "processId", "startNonce", "issuedAt"]);
  if (record["schemaVersion"] !== CONTROL_DESCRIPTOR_SCHEMA_VERSION) controlFail("INVALID_INPUT");
  return Object.freeze({
    schemaVersion: CONTROL_DESCRIPTOR_SCHEMA_VERSION,
    serviceVersion: exactString(record["serviceVersion"], VERSION, 32),
    processId: exactInteger(record["processId"], 1, 2_147_483_647),
    startNonce: exactString(record["startNonce"], START_NONCE_PATTERN, 32),
    issuedAt: exactTimestamp(record["issuedAt"]),
  });
}

export function serializeConnectionDescriptor(value: unknown): string {
  return `${toCanonicalJson(parseConnectionDescriptor(value), "connectionDescriptor")}\n`;
}

export function serializeInstanceLock(value: unknown): string {
  return `${toCanonicalJson(parseInstanceLock(value), "instanceLock")}\n`;
}
