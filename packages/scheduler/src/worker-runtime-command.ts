import { validation } from "@ai-dev-os/domain";
import { SchedulerError } from "./errors.js";
import { parseNormalizedUsage } from "./schema.js";
import { FAILURE_CLASSIFICATIONS } from "./types.js";
import {
  parseProviderCircuitEvidence,
  parseWorkerWorkDefinition,
  stableCodeUnitCompare,
} from "./worker-runtime-state.js";
import type {
  FencedWorkCommand,
  WorkerRuntimeCommand,
} from "./worker-runtime-types.js";
import {
  INTERNAL_WORKER_CANCELLATION_CODES,
  INTERNAL_WORKER_FAILURE_CODES,
} from "./worker-runtime-codes.js";

const {
  ensureArray,
  ensureBoolean,
  ensureEnum,
  ensureExactKeys,
  ensureRecord,
  ensureSafeInteger,
  ensureString,
} = validation;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;

function id(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 128,
    pattern: ID,
    patternName: "identifier",
  });
}

function publicCommandId(value: unknown, path: string): string {
  const parsed = id(value, path);
  if (parsed.startsWith("tick:")) {
    throw new SchedulerError(
      "INVALID_TASK",
      "The command identity uses a scheduler-owned namespace.",
    );
  }
  return parsed;
}

export function parseWorkerRuntimeIdempotencyKey(
  value: unknown,
  path = "idempotencyKey",
): string {
  return ensureString(value, path, {
    maxLength: 256,
    pattern: IDEMPOTENCY_KEY,
    patternName: "idempotency key",
  });
}

function code(value: unknown, path: string): string {
  return ensureString(value, path, {
    maxLength: 64,
    pattern: KIND,
    patternName: "finite code",
  });
}

function publicCode(
  value: unknown,
  path: string,
  reserved: ReadonlySet<string>,
): string {
  const parsed = code(value, path);
  if (reserved.has(parsed)) {
    throw new SchedulerError(
      "INVALID_TASK",
      "The command code is reserved for scheduler-owned transitions.",
    );
  }
  return parsed;
}

function fenced(
  input: Record<string, unknown>,
  path: string,
): FencedWorkCommand {
  return Object.freeze({
    commandId: publicCommandId(input["commandId"], `${path}.commandId`),
    idempotencyKey: parseWorkerRuntimeIdempotencyKey(
      input["idempotencyKey"],
      `${path}.idempotencyKey`,
    ),
    leaseId: id(input["leaseId"], `${path}.leaseId`),
    workerId: id(input["workerId"], `${path}.workerId`),
    fencingToken: ensureSafeInteger(
      input["fencingToken"],
      `${path}.fencingToken`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

export function parseWorkerRuntimeCommand(
  value: unknown,
  path = "command",
): WorkerRuntimeCommand {
  try {
    const input = ensureRecord(value, path);
    const type = ensureEnum(input["type"], `${path}.type`, [
      "enqueue-work",
      "claim-work",
      "renew-lease",
      "reserve-usage",
      "prepare-dispatch",
      "mark-dispatch-started",
      "complete-work",
      "fail-work",
      "cancel-work",
      "reconcile-usage",
    ] as const);
    switch (type) {
      case "enqueue-work":
        ensureExactKeys(input, ["type", "commandId", "definition"], path);
        return Object.freeze({
          type,
          commandId: publicCommandId(input["commandId"], `${path}.commandId`),
          definition: parseWorkerWorkDefinition(
            input["definition"],
            `${path}.definition`,
          ),
        });
      case "claim-work": {
        ensureExactKeys(
          input,
          ["type", "commandId", "workerId", "allowedCapacityPools"],
          path,
        );
        const allowedCapacityPools = ensureArray(
          input["allowedCapacityPools"],
          `${path}.allowedCapacityPools`,
          64,
        )
          .map((pool, index) =>
            id(pool, `${path}.allowedCapacityPools[${index}]`),
          )
          .sort(stableCodeUnitCompare);
        if (
          allowedCapacityPools.length === 0 ||
          new Set(allowedCapacityPools).size !== allowedCapacityPools.length
        ) {
          throw new SchedulerError(
            "INVALID_TASK",
            "Claim capacity pools must be nonempty and unique.",
          );
        }
        return Object.freeze({
          type,
          commandId: publicCommandId(input["commandId"], `${path}.commandId`),
          workerId: id(input["workerId"], `${path}.workerId`),
          allowedCapacityPools: Object.freeze(allowedCapacityPools),
        });
      }
      case "renew-lease":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "leaseId",
            "workerId",
            "fencingToken",
          ],
          path,
        );
        return Object.freeze({ type, ...fenced(input, path) });
      case "reserve-usage":
      case "prepare-dispatch":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "leaseId",
            "workerId",
            "fencingToken",
            "circuit",
          ],
          path,
        );
        return Object.freeze({
          type,
          ...fenced(input, path),
          circuit: parseProviderCircuitEvidence(
            input["circuit"],
            `${path}.circuit`,
          ),
        });
      case "mark-dispatch-started":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "leaseId",
            "workerId",
            "fencingToken",
            "dispatchId",
          ],
          path,
        );
        return Object.freeze({
          type,
          ...fenced(input, path),
          dispatchId: id(input["dispatchId"], `${path}.dispatchId`),
        });
      case "complete-work":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "leaseId",
            "workerId",
            "fencingToken",
            "dispatchId",
            "actualUsage",
          ],
          path,
        );
        return Object.freeze({
          type,
          ...fenced(input, path),
          dispatchId: id(input["dispatchId"], `${path}.dispatchId`),
          actualUsage: parseNormalizedUsage(
            input["actualUsage"],
            `${path}.actualUsage`,
          ),
        });
      case "fail-work":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "leaseId",
            "workerId",
            "fencingToken",
            "dispatchId",
            "classification",
            "code",
            "retryable",
            "actualUsage",
          ],
          path,
        );
        return Object.freeze({
          type,
          ...fenced(input, path),
          dispatchId:
            input["dispatchId"] === null
              ? null
              : id(input["dispatchId"], `${path}.dispatchId`),
          classification: ensureEnum(
            input["classification"],
            `${path}.classification`,
            FAILURE_CLASSIFICATIONS,
          ),
          code: publicCode(
            input["code"],
            `${path}.code`,
            INTERNAL_WORKER_FAILURE_CODES,
          ),
          retryable: ensureBoolean(input["retryable"], `${path}.retryable`),
          actualUsage: parseNormalizedUsage(
            input["actualUsage"],
            `${path}.actualUsage`,
          ),
        });
      case "cancel-work":
        ensureExactKeys(
          input,
          ["type", "commandId", "idempotencyKey", "code"],
          path,
        );
        return Object.freeze({
          type,
          commandId: publicCommandId(input["commandId"], `${path}.commandId`),
          idempotencyKey: parseWorkerRuntimeIdempotencyKey(
            input["idempotencyKey"],
            `${path}.idempotencyKey`,
          ),
          code: publicCode(
            input["code"],
            `${path}.code`,
            INTERNAL_WORKER_CANCELLATION_CODES,
          ),
        });
      case "reconcile-usage":
        ensureExactKeys(
          input,
          [
            "type",
            "commandId",
            "idempotencyKey",
            "reservationId",
            "dispatchId",
            "actualUsage",
          ],
          path,
        );
        return Object.freeze({
          type,
          commandId: publicCommandId(input["commandId"], `${path}.commandId`),
          idempotencyKey: parseWorkerRuntimeIdempotencyKey(
            input["idempotencyKey"],
            `${path}.idempotencyKey`,
          ),
          reservationId: id(input["reservationId"], `${path}.reservationId`),
          dispatchId: id(input["dispatchId"], `${path}.dispatchId`),
          actualUsage: parseNormalizedUsage(
            input["actualUsage"],
            `${path}.actualUsage`,
          ),
        });
    }
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(
      "INVALID_TASK",
      "The worker runtime command is invalid.",
    );
  }
}
