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
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProfilerArithmeticError(`${label} exceeds the safe integer range.`);
  }
  return Number(value);
}

export function ceilRatio(numerator: bigint, denominator: bigint, label: string): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new ProfilerArithmeticError(`${label} received an invalid ratio.`);
  }
  return (numerator + denominator - 1n) / denominator;
}

export class ProfilerArithmeticError extends Error {
  readonly code = "ARITHMETIC_OVERFLOW" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProfilerArithmeticError";
  }

  toJSON(): object {
    return { name: this.name, code: this.code, message: this.message };
  }
}
