import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CredentialActivitySentence, CredentialOwnership, CredentialValidationOutcome } from "@ai-dev-os/credential-ui";
import type { AppVaultSlotId } from "@ai-dev-os/secrets-app-vault";
import { APP_VAULT_SLOTS } from "@ai-dev-os/secrets-app-vault";
import { CredentialHostError } from "./host-error.js";
import { assertCredentialMetadataLabelsSafe, assertCredentialMetadataTextSafe } from "./metadata-safety.js";
import { validationDefinitive, validationResultCode } from "./validation.js";

const METADATA_SCHEMA_VERSION = 1 as const;
const METADATA_FILE_NAME = "credential-ui.v1.json" as const;
const MAX_METADATA_BYTES = 131_072;
const ID = /^cred-[0-9a-f]{32}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const SIMPLE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,160}$/u;

export interface StoredValidation {
  readonly outcome: CredentialValidationOutcome;
  readonly checkedAt: string;
  readonly recordRevision: number;
  readonly recordToken: string;
  readonly definitive: boolean;
  readonly resultCode: string;
  readonly policyDecisionFingerprint: string;
  readonly receiptState: "not-applicable" | "committed" | "historical-missing" | "write-failed";
  readonly successReceiptId: string | null;
  readonly successReceiptSha256: string | null;
}

export interface CredentialSlotMetadata {
  readonly credentialId: string;
  readonly nickname: string;
  readonly ownership: CredentialOwnership;
  readonly authorizedBy: string;
  readonly enabled: boolean;
  readonly validation: StoredValidation | null;
  readonly lastValidationAttempt: StoredValidation | null;
}

export interface CredentialMetadataSnapshot {
  readonly schemaVersion: 1;
  readonly clipboardClearDefault: boolean;
  readonly slots: Readonly<Record<AppVaultSlotId, CredentialSlotMetadata | null>>;
  readonly activity: readonly CredentialActivitySentence[];
}

export interface CredentialMetadataStore {
  read(): Promise<CredentialMetadataSnapshot>;
  write(snapshot: CredentialMetadataSnapshot): Promise<void>;
  update(
    transform: (current: CredentialMetadataSnapshot) => CredentialMetadataSnapshot,
    commitAllowed?: () => boolean,
  ): Promise<CredentialMetadataSnapshot>;
}

function emptySlots(): Record<AppVaultSlotId, CredentialSlotMetadata | null> {
  return { anthropic: null, openai: null, gemini: null, openrouter: null };
}

export function emptyCredentialMetadata(): CredentialMetadataSnapshot {
  return Object.freeze({ schemaVersion: METADATA_SCHEMA_VERSION, clipboardClearDefault: true, slots: Object.freeze(emptySlots()), activity: Object.freeze([]) });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw new CredentialHostError("METADATA_UNAVAILABLE");
    output[key] = descriptor.value;
  }
  return output;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0) || (value.length > 0 && !SIMPLE_TEXT.test(value))) throw new CredentialHostError("METADATA_UNAVAILABLE");
  return value;
}

function timestamp(value: unknown): string {
  const text = boundedText(value, 64);
  if (new Date(text).toISOString() !== text) throw new CredentialHostError("METADATA_UNAVAILABLE");
  return text;
}

function parseValidation(slotId: AppVaultSlotId, value: unknown): StoredValidation | null {
  if (value === null) return null;
  const legacy = typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 7;
  const record = exactRecord(value, legacy
    ? ["outcome", "checkedAt", "recordRevision", "recordToken", "definitive", "resultCode", "policyDecisionFingerprint"]
    : ["outcome", "checkedAt", "recordRevision", "recordToken", "definitive", "resultCode", "policyDecisionFingerprint", "receiptState", "successReceiptId", "successReceiptSha256"]);
  const outcomes = ["valid", "invalid", "unauthorized", "ambiguous", "unreachable", "evidence-incomplete"] as const;
  if (!outcomes.includes(record["outcome"] as never) || typeof record["recordRevision"] !== "number" || !Number.isSafeInteger(record["recordRevision"]) || record["recordRevision"] < 1 || typeof record["recordToken"] !== "string" || !TOKEN.test(record["recordToken"]) || typeof record["definitive"] !== "boolean" || typeof record["policyDecisionFingerprint"] !== "string" || !TOKEN.test(record["policyDecisionFingerprint"])) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const outcome = record["outcome"] as CredentialValidationOutcome;
  const resultCode = boundedText(record["resultCode"], 64);
  if (record["definitive"] !== validationDefinitive(outcome) || resultCode !== validationResultCode(outcome)) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const observedReceiptState = legacy
    ? outcome === "valid" ? "historical-missing" as const : "not-applicable" as const
    : record["receiptState"];
  const successReceiptId = legacy ? null : record["successReceiptId"];
  const successReceiptSha256 = legacy ? null : record["successReceiptSha256"];
  if (
    !(["not-applicable", "committed", "historical-missing", "write-failed"] as const).includes(observedReceiptState as never) ||
    (successReceiptId !== null && (typeof successReceiptId !== "string" || !TOKEN.test(successReceiptId))) ||
    (successReceiptSha256 !== null && (typeof successReceiptSha256 !== "string" || !TOKEN.test(successReceiptSha256))) ||
    (observedReceiptState === "committed" && slotId !== "anthropic") ||
    (observedReceiptState === "committed" && (outcome !== "valid" || successReceiptId === null || successReceiptSha256 === null)) ||
    (observedReceiptState === "historical-missing" && (outcome !== "valid" || successReceiptId !== null || successReceiptSha256 !== null)) ||
    (observedReceiptState === "write-failed" && (outcome !== "evidence-incomplete" || successReceiptId !== null || successReceiptSha256 !== null)) ||
    (observedReceiptState === "not-applicable" && (outcome === "valid" || outcome === "evidence-incomplete" || successReceiptId !== null || successReceiptSha256 !== null))
  ) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const receiptState = observedReceiptState as StoredValidation["receiptState"];
  return Object.freeze({ outcome, checkedAt: timestamp(record["checkedAt"]), recordRevision: record["recordRevision"], recordToken: record["recordToken"], definitive: record["definitive"], resultCode, policyDecisionFingerprint: record["policyDecisionFingerprint"], receiptState, successReceiptId: successReceiptId as string | null, successReceiptSha256: successReceiptSha256 as string | null });
}

function sameValidation(left: StoredValidation, right: StoredValidation): boolean {
  return left.outcome === right.outcome
    && left.checkedAt === right.checkedAt
    && left.recordRevision === right.recordRevision
    && left.recordToken === right.recordToken
    && left.definitive === right.definitive
    && left.resultCode === right.resultCode
    && left.policyDecisionFingerprint === right.policyDecisionFingerprint
    && left.receiptState === right.receiptState
    && left.successReceiptId === right.successReceiptId
    && left.successReceiptSha256 === right.successReceiptSha256;
}

function parseSlot(slotId: AppVaultSlotId, value: unknown): CredentialSlotMetadata | null {
  if (value === null) return null;
  const record = exactRecord(value, ["credentialId", "nickname", "ownership", "authorizedBy", "enabled", "validation", "lastValidationAttempt"]);
  if (typeof record["credentialId"] !== "string" || !ID.test(record["credentialId"]) || (record["ownership"] !== "owned" && record["ownership"] !== "authorized") || typeof record["enabled"] !== "boolean") throw new CredentialHostError("METADATA_UNAVAILABLE");
  const authorizedBy = boundedText(record["authorizedBy"], 40, true);
  const nickname = boundedText(record["nickname"], 40);
  if ((record["ownership"] === "owned" && authorizedBy.length !== 0) || (record["ownership"] === "authorized" && authorizedBy.length === 0)) throw new CredentialHostError("METADATA_UNAVAILABLE");
  assertCredentialMetadataLabelsSafe(nickname, authorizedBy, "METADATA_UNAVAILABLE");
  const validation = parseValidation(slotId, record["validation"]);
  const lastValidationAttempt = parseValidation(slotId, record["lastValidationAttempt"]);
  if (validation === null && lastValidationAttempt?.definitive === true) throw new CredentialHostError("METADATA_UNAVAILABLE");
  if (validation !== null && lastValidationAttempt === null) throw new CredentialHostError("METADATA_UNAVAILABLE");
  if (validation !== null && lastValidationAttempt !== null && validation.recordToken !== lastValidationAttempt.recordToken) throw new CredentialHostError("METADATA_UNAVAILABLE");
  if (lastValidationAttempt?.definitive === true && (validation === null || !sameValidation(validation, lastValidationAttempt))) throw new CredentialHostError("METADATA_UNAVAILABLE");
  if (validation?.definitive === false && (lastValidationAttempt === null || !sameValidation(validation, lastValidationAttempt))) throw new CredentialHostError("METADATA_UNAVAILABLE");
  return Object.freeze({ credentialId: record["credentialId"], nickname, ownership: record["ownership"], authorizedBy, enabled: record["enabled"], validation, lastValidationAttempt });
}

function parseActivity(value: unknown): readonly CredentialActivitySentence[] {
  if (!Array.isArray(value) || value.length > 50) throw new CredentialHostError("METADATA_UNAVAILABLE");
  return Object.freeze(value.map((item) => {
    const record = exactRecord(item, ["id", "at", "tone", "text"]);
    if (!(["info", "ok", "warn", "danger"] as const).includes(record["tone"] as never)) throw new CredentialHostError("METADATA_UNAVAILABLE");
    const text = boundedText(record["text"], 160);
    assertCredentialMetadataTextSafe(text, "METADATA_UNAVAILABLE");
    return Object.freeze({ id: boundedText(record["id"], 64), at: timestamp(record["at"]), tone: record["tone"] as CredentialActivitySentence["tone"], text });
  }));
}

export function parseCredentialMetadata(value: unknown): CredentialMetadataSnapshot {
  const record = exactRecord(value, ["schemaVersion", "clipboardClearDefault", "slots", "activity"]);
  if (record["schemaVersion"] !== METADATA_SCHEMA_VERSION || typeof record["clipboardClearDefault"] !== "boolean") throw new CredentialHostError("METADATA_UNAVAILABLE");
  const slotsRecord = exactRecord(record["slots"], APP_VAULT_SLOTS.map((slot) => slot.slotId));
  const slots = emptySlots();
  for (const descriptor of APP_VAULT_SLOTS) slots[descriptor.slotId] = parseSlot(descriptor.slotId, slotsRecord[descriptor.slotId]);
  return Object.freeze({ schemaVersion: METADATA_SCHEMA_VERSION, clipboardClearDefault: record["clipboardClearDefault"], slots: Object.freeze(slots), activity: parseActivity(record["activity"]) });
}

export function replaceSlotMetadata(snapshot: CredentialMetadataSnapshot, slotId: AppVaultSlotId, metadata: CredentialSlotMetadata | null, activity: CredentialActivitySentence | null = null): CredentialMetadataSnapshot {
  const slots = { ...snapshot.slots, [slotId]: metadata };
  const activities = activity === null ? [...snapshot.activity] : [activity, ...snapshot.activity].slice(0, 50);
  return parseCredentialMetadata({ schemaVersion: 1, clipboardClearDefault: snapshot.clipboardClearDefault, slots, activity: activities });
}

export function createMemoryCredentialMetadataStore(initial: CredentialMetadataSnapshot = emptyCredentialMetadata()): CredentialMetadataStore & { snapshot(): CredentialMetadataSnapshot } {
  let current = parseCredentialMetadata(initial);
  let sequence: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const pending = sequence.then(work);
    sequence = pending.then(() => undefined, () => undefined);
    return pending;
  };
  return Object.freeze({
    async read() { await sequence; return current; },
    async write(snapshot: CredentialMetadataSnapshot) {
      const parsed = parseCredentialMetadata(snapshot);
      const work = async (): Promise<void> => { current = parsed; };
      await enqueue(work);
    },
    async update(transform: (snapshot: CredentialMetadataSnapshot) => CredentialMetadataSnapshot, commitAllowed?: () => boolean) {
      let updated: CredentialMetadataSnapshot | null = null;
      const work = async (): Promise<void> => {
        updated = parseCredentialMetadata(transform(current));
        if (commitAllowed !== undefined && !commitAllowed()) throw new CredentialHostError("VALIDATION_STALE");
        current = updated;
      };
      await enqueue(work);
      return updated!;
    },
    snapshot: () => current,
  });
}

export function createFileCredentialMetadataStore(root: string): CredentialMetadataStore {
  const resolvedRoot = resolve(root);
  if (!isAbsolute(resolvedRoot)) throw new CredentialHostError("METADATA_UNAVAILABLE");
  const target = resolve(resolvedRoot, METADATA_FILE_NAME);
  const rel = relative(resolvedRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new CredentialHostError("METADATA_UNAVAILABLE");
  let sequence: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const pending = sequence.then(work);
    sequence = pending.then(() => undefined, () => undefined);
    return pending;
  };
  async function readInternal(): Promise<CredentialMetadataSnapshot> {
    let handle;
    let bytes: Buffer | undefined;
    const extra = Buffer.alloc(1);
    try {
      try { handle = await open(target, "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentialMetadata();
        throw error;
      }
      const status = await handle.stat();
      if (!status.isFile() || !Number.isSafeInteger(status.size) || status.size > MAX_METADATA_BYTES) throw new CredentialHostError("METADATA_UNAVAILABLE");
      bytes = Buffer.alloc(status.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) throw new CredentialHostError("METADATA_UNAVAILABLE");
        offset += result.bytesRead;
      }
      if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) throw new CredentialHostError("METADATA_UNAVAILABLE");
      return parseCredentialMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    } catch (error) {
      if (error instanceof CredentialHostError) throw error;
      throw new CredentialHostError("METADATA_UNAVAILABLE");
    } finally {
      bytes?.fill(0);
      extra.fill(0);
      try { await handle?.close(); } catch { /* bounded read cleanup */ }
    }
  }
  async function writeInternal(parsed: CredentialMetadataSnapshot, commitAllowed?: () => boolean): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
    if (bytes.byteLength > MAX_METADATA_BYTES) throw new CredentialHostError("METADATA_UNAVAILABLE");
    await mkdir(resolvedRoot, { recursive: true });
    const temporary = join(resolvedRoot, `.credential-ui.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (commitAllowed !== undefined && !commitAllowed()) throw new CredentialHostError("VALIDATION_STALE");
      await rename(temporary, target);
    } catch {
      try { await handle?.close(); } catch { /* fixed cleanup */ }
      try { await unlink(temporary); } catch { /* fixed cleanup */ }
      throw new CredentialHostError("METADATA_UNAVAILABLE");
    } finally { bytes.fill(0); }
  }
  return Object.freeze({
    async read() { await sequence; return await readInternal(); },
    async write(snapshot: CredentialMetadataSnapshot) {
      const parsed = parseCredentialMetadata(snapshot);
      const work = async (): Promise<void> => {
        await readInternal();
        await writeInternal(parsed);
      };
      await enqueue(work);
    },
    async update(transform: (snapshot: CredentialMetadataSnapshot) => CredentialMetadataSnapshot, commitAllowed?: () => boolean) {
      let updated: CredentialMetadataSnapshot | null = null;
      const work = async (): Promise<void> => {
        const current = await readInternal();
        updated = parseCredentialMetadata(transform(current));
        await writeInternal(updated, commitAllowed);
      };
      await enqueue(work);
      return updated!;
    },
  });
}
