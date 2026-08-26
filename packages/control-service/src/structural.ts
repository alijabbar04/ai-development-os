import { types as utilTypes } from "node:util";
import { controlFail } from "./errors.js";

export function readExactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) controlFail("INVALID_INPUT");
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    ) controlFail("INVALID_INPUT");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor)) controlFail("INVALID_INPUT");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === "ControlServiceError") throw error;
    controlFail("INVALID_INPUT");
  }
}

export function readExactArray(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (
      typeof value !== "object" || value === null || utilTypes.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      !Number.isSafeInteger(maximum) || maximum < 0 || value.length > maximum
    ) controlFail("INVALID_INPUT");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
      controlFail("INVALID_INPUT");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        controlFail("INVALID_INPUT");
      }
      output.push(descriptor.value);
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof Error && error.name === "ControlServiceError") throw error;
    controlFail("INVALID_INPUT");
  }
}

export function exactString(value: unknown, pattern: RegExp, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    controlFail("INVALID_INPUT");
  }
  return value;
}

export function exactInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    controlFail("INVALID_INPUT");
  }
  return value as number;
}

export function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) controlFail("INVALID_INPUT");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) controlFail("INVALID_INPUT");
  return value;
}

export function parseJsonDocument(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    controlFail("ARTIFACT_INVALID");
  }
}
