import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";

export const HEX_64 = /^[0-9a-f]{64}$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const SAFE_KIND = /^[a-z][a-z0-9._-]{0,63}$/u;

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(toCanonicalJson(value), "utf8").digest("hex");
}

export function checkedNumber(value: bigint, label: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RouterError("ARITHMETIC_OVERFLOW", `${label} exceeds the safe integer range.`);
  }
  return Number(value);
}

export function ceilRatio(numerator: bigint, denominator: bigint, label: string): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RouterError("ARITHMETIC_OVERFLOW", `${label} received an invalid ratio.`);
  }
  return (numerator + denominator - 1n) / denominator;
}

export const ROUTER_ERROR_CODES = Object.freeze([
  "INVALID_CONFIGURATION",
  "INVALID_REQUEST",
  "INVALID_CANDIDATE",
  "FINGERPRINT_MISMATCH",
  "ARITHMETIC_OVERFLOW",
  "ROUTER_CLOSED",
  "INVALID_CIRCUIT_TRANSITION",
  "BUDGET_PLAN_FAILED"
] as const);
export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number];

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: RouterErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {}
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}
