import { createHash } from "node:crypto";
import { canonicalizeJson, toCanonicalJson, type JsonObject } from "@ai-dev-os/domain";
import { parseOrchestrationEvent } from "./schema.js";
import { ORCHESTRATION_EVENT_SCHEMA_VERSION, type OrchestrationEvent, type OrchestrationEventType } from "./types.js";

export interface CreateOrchestrationEventInput {
  readonly taskId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: OrchestrationEventType;
  readonly payload: unknown;
}

export function createOrchestrationEvent(input: CreateOrchestrationEventInput): OrchestrationEvent {
  const payload = canonicalizeJson(input.payload, "event.payload") as JsonObject;
  const eventId = `event:${createHash("sha256").update(toCanonicalJson({
    taskId: input.taskId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: input.type,
    payload,
  })).digest("hex").slice(0, 40)}`;
  return parseOrchestrationEvent({
    schemaVersion: ORCHESTRATION_EVENT_SCHEMA_VERSION,
    eventId,
    taskId: input.taskId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: input.type,
    payload,
  });
}
