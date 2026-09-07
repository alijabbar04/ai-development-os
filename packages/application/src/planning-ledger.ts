import { checksumEquals, computeChecksumOfText, parseAggregateType, type AggregateEnvelope, type AggregateType, type EventRecord, type PersistenceAdapter, type TransactionContext } from "@ai-dev-os/persistence";
import { parseApprovalOperation } from "@ai-dev-os/approval";
import type { PlanningCommandResult } from "./planning-contracts.js";
import { canonicalPlanning, digestPlanning, parsePlanningCommand, planningArray, planningHash, planningId, planningInteger, planningObject, planningText, refusePlanning } from "./planning-validation.js";

export interface PlanningConfirmation {
  readonly reviewId: string;
  readonly identityRef: "operator:local-desktop";
  readonly approverClass: "project-owner";
  readonly confirmedAt: string;
  readonly subjectDigest: string;
}
export function parsePlanningConfirmation(value: unknown): PlanningConfirmation {
  try {
    const c = planningObject(value, ["reviewId", "identityRef", "approverClass", "confirmedAt", "subjectDigest"]);
    if (c["identityRef"] !== "operator:local-desktop" || c["approverClass"] !== "project-owner" || !/^[a-f0-9]{64}$/u.test(String(c["subjectDigest"])) || new Date(String(c["confirmedAt"])).toISOString() !== c["confirmedAt"]) throw new Error();
    planningId(c["reviewId"]); return value as PlanningConfirmation;
  } catch { return refusePlanning("confirmation.record-corrupt", "corrupt"); }
}
export type PlanningEffect = Readonly<{
  kind: "aggregate" | "event"; aggregateType: AggregateType; aggregateId: string;
  version: number; checksum: string; eventId: string | null;
}>;
export type PlanningReceiptResult = Pick<PlanningCommandResult, "kind" | "commandId" | "reason" | "projectId">;
export interface PlanningReceipt {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly commandKind: string;
  readonly inputDigest: string;
  readonly at: string;
  readonly confirmation: PlanningConfirmation | null;
  readonly material: unknown;
  readonly effects: readonly PlanningEffect[];
  readonly result: PlanningReceiptResult;
}
export function verifyPlanningEnvelope(value: AggregateEnvelope, type = value.aggregateType, id = value.aggregateId): AggregateEnvelope {
  try {
    if (value.aggregateType !== type || value.aggregateId !== id || value.schemaVersion !== 1 || planningInteger(value.aggregateVersion) < 1
      || !checksumEquals(value.checksum, computeChecksumOfText(canonicalPlanning(value.payload)))
      || new Date(value.createdAt).toISOString() !== value.createdAt || new Date(value.updatedAt).toISOString() !== value.updatedAt || value.updatedAt < value.createdAt) throw new Error();
    return value;
  } catch { return refusePlanning("store.corrupt", "corrupt"); }
}
export async function listPlanningAggregates(tx: TransactionContext, type: AggregateType, maximum = 1000): Promise<readonly AggregateEnvelope[]> {
  const rows: AggregateEnvelope[] = [], cursors = new Set<string>();
  let cursor: string | null = null, prior = "";
  const deadline = Date.now() + 10_000;
  do {
    if (Date.now() >= deadline) return refusePlanning("store.evidence-bound");
    const page = await tx.aggregates.list({ aggregateType: type, cursor, limit: Math.min(100, maximum + 1 - rows.length) });
    if (page.items.length > 100 || page.items.length === 0 && page.nextCursor !== null) return refusePlanning("store.cursor-invalid", "corrupt");
    for (const row of page.items) {
      verifyPlanningEnvelope(row, type);
      if (row.aggregateId <= prior) return refusePlanning("store.order-invalid", "corrupt");
      prior = row.aggregateId; rows.push(row);
      if (rows.length > maximum) return refusePlanning("store.evidence-bound");
    }
    cursor = page.nextCursor;
    if (cursor !== null) { if (typeof cursor !== "string" || cursors.has(cursor)) return refusePlanning("store.cursor-invalid", "corrupt"); cursors.add(cursor); }
  } while (cursor !== null);
  return Object.freeze(rows);
}
export async function listPlanningEvents(tx: TransactionContext, type: AggregateType, id: string, maximum = 1000): Promise<readonly EventRecord[]> {
  const events: EventRecord[] = [], cursors = new Set<string>();
  let cursor: string | null = null, previous = 0;
  const deadline = Date.now() + 10_000;
  do {
    if (Date.now() >= deadline) return refusePlanning("store.evidence-bound");
    const page = await tx.events.list({ aggregateType: type, aggregateId: id, cursor, limit: Math.min(100, maximum + 1 - events.length) });
    if (page.items.length > 100 || page.items.length === 0 && page.nextCursor !== null) return refusePlanning("store.cursor-invalid", "corrupt");
    for (const event of page.items) {
      if (event.aggregateType !== type || event.aggregateId !== id || event.eventSchemaVersion !== 1 || event.globalSequence <= previous
        || !checksumEquals(event.checksum, computeChecksumOfText(canonicalPlanning(event.payload)))) return refusePlanning("store.event-corrupt", "corrupt");
      previous = event.globalSequence; events.push(event);
      if (events.length > maximum) return refusePlanning("store.evidence-bound");
    }
    cursor = page.nextCursor;
    if (cursor !== null) { if (typeof cursor !== "string" || cursors.has(cursor)) return refusePlanning("store.cursor-invalid", "corrupt"); cursors.add(cursor); }
  } while (cursor !== null);
  return Object.freeze(events);
}
/** Bind existing C7 store code to the current transaction; no nested transaction or second connection. */
export function planningTransactionAdapter(tx: TransactionContext): PersistenceAdapter {
  return Object.freeze({
    transact: async <T>(work: (value: TransactionContext) => Promise<T> | T): Promise<T> => await work(tx),
    migrationStatus: async () => { throw new Error("TRANSACTION_FACADE_OPERATION_UNAVAILABLE"); },
    close: async () => { throw new Error("TRANSACTION_FACADE_OPERATION_UNAVAILABLE"); },
  });
}
export function capturePlanningEffects(tx: TransactionContext): Readonly<{ tx: TransactionContext; effects: PlanningEffect[] }> {
  const effects: PlanningEffect[] = [];
  const aggregate = (row: AggregateEnvelope): AggregateEnvelope => { verifyPlanningEnvelope(row); effects.push(Object.freeze({ kind: "aggregate", aggregateType: row.aggregateType, aggregateId: row.aggregateId, version: row.aggregateVersion, checksum: row.checksum.hex, eventId: null })); return row; };
  return Object.freeze({ effects, tx: Object.freeze({ ...tx,
    aggregates: Object.freeze({ ...tx.aggregates,
      create: async (input: Parameters<TransactionContext["aggregates"]["create"]>[0]) => aggregate(await tx.aggregates.create(input)),
      update: async (input: Parameters<TransactionContext["aggregates"]["update"]>[0]) => aggregate(await tx.aggregates.update(input)),
    }),
    events: Object.freeze({ ...tx.events, append: async (input: Parameters<TransactionContext["events"]["append"]>[0]) => {
      const row = await tx.events.append(input);
      effects.push(Object.freeze({ kind: "event", aggregateType: row.aggregateType, aggregateId: row.aggregateId, version: row.aggregateVersion, checksum: row.checksum.hex, eventId: row.eventId }));
      if (effects.length > 256) return refusePlanning("command.effect-bound");
      return row;
    } }),
  }) });
}
export async function writePlanningAggregate(tx: TransactionContext, type: AggregateType, id: string, payload: unknown, version: number, commandId: string, eventType: string, at: string): Promise<AggregateEnvelope> {
  const input = { aggregateType: type, aggregateId: id, schemaVersion: 1, payload };
  const row = version === 0 ? await tx.aggregates.create(input) : await tx.aggregates.update({ ...input, expectedVersion: version });
  await tx.events.append({ eventId: `planning-event:${digestPlanning([commandId, type, id, row.aggregateVersion]).slice(0, 32)}`, aggregateType: type, aggregateId: id, aggregateVersion: row.aggregateVersion,
    eventType, eventSchemaVersion: 1, payload: { schemaVersion: 1, commandId, record: payload }, occurredAt: at, causationId: commandId });
  return verifyPlanningEnvelope(row);
}
const receiptId = (id: string): string => `planning-command:${digestPlanning(planningId(id)).slice(0, 32)}`;
interface PlanningIntent { readonly schemaVersion: 1; readonly kind: "planning-command-intent"; readonly commandId: string; readonly commandKind: string; readonly inputDigest: string; readonly projectId: string | null; readonly at: string }
function parseIntent(value: unknown): PlanningIntent {
  try {
    const r = planningObject(value, ["schemaVersion", "kind", "commandId", "commandKind", "inputDigest", "projectId", "at"]);
    if (r["schemaVersion"] !== 1 || r["kind"] !== "planning-command-intent" || !/^[a-f0-9]{64}$/u.test(String(r["inputDigest"])) || new Date(String(r["at"])).toISOString() !== r["at"]) throw new Error();
    planningId(r["commandId"]); planningText(r["commandKind"], 40); if (r["projectId"] !== null) planningId(r["projectId"]);
    return value as PlanningIntent;
  } catch { return refusePlanning("command.intent-corrupt", "corrupt"); }
}
export async function recordPlanningIntent(tx: TransactionContext, intent: Omit<PlanningIntent, "schemaVersion" | "kind">): Promise<void> {
  const value = parseIntent({ schemaVersion: 1, kind: "planning-command-intent", ...intent }), id = receiptId(intent.commandId);
  if ((await listPlanningAggregates(tx, "planning-command")).length >= 1000) return refusePlanning("command.history-capacity");
  await tx.aggregates.create({ aggregateType: "planning-command", aggregateId: id, schemaVersion: 1, payload: value });
  await tx.events.append({ eventId: `${id}:intent`, aggregateType: "planning-command", aggregateId: id, aggregateVersion: 1, eventType: "planning-command.intent", eventSchemaVersion: 1,
    payload: { schemaVersion: 1, intent: value, intentDigest: digestPlanning(value) }, occurredAt: value.at, causationId: value.commandId });
}
function parseReceipt(value: unknown): PlanningReceipt {
  try {
    const r = planningObject(value, ["schemaVersion", "commandId", "commandKind", "inputDigest", "at", "confirmation", "material", "effects", "result"]);
    if (r["schemaVersion"] !== 1 || !/^[a-f0-9]{64}$/u.test(String(r["inputDigest"]))) throw new Error();
    planningId(r["commandId"]); planningText(r["commandKind"], 40);
    if (new Date(String(r["at"])).toISOString() !== r["at"]) throw new Error();
    const result = planningObject(r["result"], ["kind", "commandId", "reason", "projectId"]);
    if (result["commandId"] !== r["commandId"] || !["committed", "refused", "conflict", "cancelled", "not-recorded"].includes(String(result["kind"]))) throw new Error();
    if (result["projectId"] !== null) planningId(result["projectId"]);
    if (result["reason"] !== null) planningText(result["reason"], 128);
    if (r["confirmation"] !== null) parsePlanningConfirmation(r["confirmation"]);
    planningArray(r["effects"], (value) => { const e = planningObject(value, ["kind", "aggregateType", "aggregateId", "version", "checksum", "eventId"]);
      if (!["aggregate", "event"].includes(String(e["kind"])) || !/^[a-f0-9]{64}$/u.test(String(e["checksum"])) || planningInteger(e["version"]) < 1) throw new Error();
      parseAggregateType(e["aggregateType"]); planningId(e["aggregateId"]);
      if (e["kind"] === "event") planningId(e["eventId"]); else if (e["eventId"] !== null) throw new Error();
      return e;
    }, 256);
    if (result["kind"] === "committed") {
      if (r["confirmation"] === null || (r["effects"] as unknown[]).length === 0 || result["reason"] !== null || result["projectId"] === null) throw new Error();
      const material = planningObject(r["material"]);
      if (String(r["commandKind"]).startsWith("approval.")) {
        const operation = parseApprovalOperation(material, planningHash);
        if (`approval.${operation.kind}` !== r["commandKind"] || operation.operationId !== r["commandId"] || operation.request.approval.scope.projectId !== result["projectId"] || digestPlanning(operation) !== r["inputDigest"]) throw new Error();
      } else if (r["commandKind"] === "create-project") {
        // The unaccepted objective/outcomes stay ephemeral. The durable create
        // attempt binds their digest, while only real project/budget facts save.
        planningObject(material, ["project", "localBudget"]);
        if (planningObject(material["project"])["projectId"] !== result["projectId"]) throw new Error();
      } else {
        const command = parsePlanningCommand(material["command"] ?? material);
        if (!("commandId" in command) || !("projectId" in command) || command.kind !== r["commandKind"] || command.commandId !== r["commandId"] || command.projectId !== result["projectId"] || digestPlanning(command) !== r["inputDigest"]) throw new Error();
      }
    } else if (r["material"] !== null || (r["effects"] as unknown[]).length !== 0) throw new Error();
    if (canonicalPlanning(value).length > 524_288) throw new Error();
    return value as PlanningReceipt;
  } catch { return refusePlanning("command.receipt-corrupt", "corrupt"); }
}
export async function recordPlanningReceipt(tx: TransactionContext, receipt: PlanningReceipt): Promise<void> {
  parseReceipt(receipt);
  const id = receiptId(receipt.commandId);
  const existing = await tx.aggregates.get("planning-command", id);
  let version = 1;
  if (existing === null) {
    if ((await listPlanningAggregates(tx, "planning-command")).length >= 1000) return refusePlanning("command.history-capacity");
    await tx.aggregates.create({ aggregateType: "planning-command", aggregateId: id, schemaVersion: 1, payload: receipt });
  } else {
    verifyPlanningEnvelope(existing, "planning-command", id);
    const intent = parseIntent(existing.payload);
    if (existing.aggregateVersion !== 1 || intent.commandId !== receipt.commandId || intent.inputDigest !== receipt.inputDigest) return refusePlanning("command.intent-conflict", "conflict");
    await tx.aggregates.update({ aggregateType: "planning-command", aggregateId: id, schemaVersion: 1, payload: receipt, expectedVersion: 1 }); version = 2;
  }
  await tx.events.append({ eventId: id, aggregateType: "planning-command", aggregateId: id, aggregateVersion: version, eventType: "planning-command.completed", eventSchemaVersion: 1,
    payload: { schemaVersion: 1, receiptDigest: digestPlanning(receipt) }, occurredAt: receipt.at, causationId: receipt.commandId });
}
export async function observePlanningReceipt(tx: TransactionContext, commandId: string, inputDigest?: string, activeIntent = false): Promise<PlanningReceipt | null> {
  const id = receiptId(commandId), envelope = await tx.aggregates.get("planning-command", id);
  if (envelope === null) return null;
  verifyPlanningEnvelope(envelope, "planning-command", id);
  if (planningObject(envelope.payload)["kind"] === "planning-command-intent") {
    const intent = parseIntent(envelope.payload), events = await listPlanningEvents(tx, "planning-command", id, 1);
    if (envelope.aggregateVersion !== 1 || intent.commandId !== commandId || events.length !== 1 || events[0]!.eventId !== `${id}:intent` || events[0]!.eventType !== "planning-command.intent"
      || events[0]!.aggregateVersion !== 1 || events[0]!.occurredAt !== intent.at || events[0]!.causationId !== commandId
      || canonicalPlanning(events[0]!.payload) !== canonicalPlanning({ schemaVersion: 1, intent, intentDigest: digestPlanning(intent) })) return refusePlanning("command.intent-journal-corrupt", "corrupt");
    if (inputDigest !== undefined && intent.inputDigest !== inputDigest) return refusePlanning("command.material-conflict", "conflict");
    if (activeIntent) return null;
    // The result transition and every effect are one C7 transaction. After the
    // owning command is drained (or on restart), this remaining intent proves
    // that transaction did not commit; it is never automatically retried.
    return Object.freeze({ schemaVersion: 1, commandId, commandKind: intent.commandKind, inputDigest: intent.inputDigest, at: intent.at, confirmation: null, material: null, effects: [],
      result: { kind: "not-recorded" as const, commandId, reason: "command.interrupted-before-commit", projectId: intent.projectId } });
  }
  const receipt = parseReceipt(envelope.payload);
  if (receipt.commandId !== commandId || ![1, 2].includes(envelope.aggregateVersion)) return refusePlanning("command.identity-corrupt", "corrupt");
  // Intrinsic evidence is verified before comparing new caller material.
  const journal = await listPlanningEvents(tx, "planning-command", id, 2), completed = journal.at(-1);
  if (journal.length !== envelope.aggregateVersion || completed?.eventId !== id || completed.aggregateVersion !== envelope.aggregateVersion
    || completed.eventType !== "planning-command.completed" || completed.occurredAt !== receipt.at || completed.causationId !== commandId
    || canonicalPlanning(completed.payload) !== canonicalPlanning({ schemaVersion: 1, receiptDigest: digestPlanning(receipt) })
    || envelope.aggregateVersion === 2 && (journal[0]!.eventId !== `${id}:intent` || journal[0]!.eventType !== "planning-command.intent" || journal[0]!.aggregateVersion !== 1)) return refusePlanning("command.journal-corrupt", "corrupt");
  if (envelope.aggregateVersion === 2) {
    const event = journal[0]!, payload = planningObject(event.payload, ["schemaVersion", "intent", "intentDigest"]), intent = parseIntent(payload["intent"]);
    if (payload["schemaVersion"] !== 1 || payload["intentDigest"] !== digestPlanning(intent) || intent.commandId !== commandId || intent.commandKind !== receipt.commandKind || intent.inputDigest !== receipt.inputDigest
      || intent.projectId !== null && intent.projectId !== receipt.result.projectId || intent.at > receipt.at || event.occurredAt !== intent.at || event.causationId !== commandId) return refusePlanning("command.intent-journal-corrupt", "corrupt");
  }
  const eventCache = new Map<string, readonly EventRecord[]>();
  for (const effect of receipt.effects) {
    if (effect.kind === "aggregate") {
      const current = await tx.aggregates.get(effect.aggregateType, effect.aggregateId);
      if (current === null) return refusePlanning("command.partial-transaction", "corrupt");
      verifyPlanningEnvelope(current, effect.aggregateType, effect.aggregateId);
      if (current.aggregateVersion < effect.version || current.aggregateVersion === effect.version && current.checksum.hex !== effect.checksum) return refusePlanning("command.effect-corrupt", "corrupt");
    } else {
      const key = `${effect.aggregateType}/${effect.aggregateId}`;
      let events = eventCache.get(key);
      if (events === undefined) { events = await listPlanningEvents(tx, effect.aggregateType, effect.aggregateId); eventCache.set(key, events); }
      const matches = events.filter((event) => event.eventId === effect.eventId);
      if (matches.length !== 1 || matches[0]!.aggregateVersion !== effect.version || matches[0]!.checksum.hex !== effect.checksum) return refusePlanning("command.partial-transaction", "corrupt");
    }
  }
  if (inputDigest !== undefined && receipt.inputDigest !== inputDigest) return refusePlanning("command.material-conflict", "conflict");
  return receipt;
}
