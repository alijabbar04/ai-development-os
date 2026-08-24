import { createHash, randomBytes } from "node:crypto";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
  ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES,
  AnthropicValidationReceiptError,
  parseAnthropicValidationSuccessReceipt,
  parseCanonicalAnthropicValidationSuccessReceipt,
  serializeAnthropicValidationSuccessReceipt,
  type AnthropicValidationSuccessReceipt,
} from "./anthropic-validation-receipt.js";

const COMMIT_VERSION = "ai-dev-os.stage-18e-i.anthropic-success-receipt-commit.v1" as const;
const MAX_COMMIT_BYTES = 2_048;
const MAX_ROOT_LENGTH = 1_024;
const HASH = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface AnthropicValidationSuccessReceiptReference {
  readonly receiptId: string;
  readonly receiptSha256: string;
}

export interface AnthropicValidationSuccessReceiptProjection {
  readonly receipt: AnthropicValidationSuccessReceipt;
  readonly reference: AnthropicValidationSuccessReceiptReference;
  readonly canonicalDocument: string;
}

export interface AnthropicValidationSuccessReceiptStore {
  commit(receipt: unknown): Promise<AnthropicValidationSuccessReceiptReference>;
  readCommitted(
    receiptId: string,
    expected?: Readonly<{
      receiptSha256?: string;
      candidateHead?: string;
      candidateTree?: string;
      candidateManifestAggregate?: string;
    }>,
  ): Promise<AnthropicValidationSuccessReceiptProjection>;
}

export interface AnthropicValidationReceiptDurabilityPort {
  syncDirectoryEntry(directory: string, target: string): Promise<void>;
}

interface ReceiptCommit {
  readonly schemaVersion: 1;
  readonly commitVersion: typeof COMMIT_VERSION;
  readonly digestConvention: typeof ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION;
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly receiptBytes: number;
  readonly state: "committed";
}

interface FileSystemIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface ReceiptRootBinding {
  readonly identity: FileSystemIdentity;
  readonly realPath: string;
}

function failure(code: AnthropicValidationReceiptError["code"]): never {
  throw new AnthropicValidationReceiptError(code);
}

function errorCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch { return null; }
}

function exactCommit(value: unknown): ReceiptCommit {
  try {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) failure("RECEIPT_INVALID");
    const expected = ["schemaVersion", "commitVersion", "digestConvention", "receiptId", "receiptSha256", "receiptBytes", "state"] as const;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key as never))) failure("RECEIPT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const field = (key: typeof expected[number]): unknown => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) failure("RECEIPT_INVALID");
      return descriptor.value;
    };
    if (
      field("schemaVersion") !== 1 || field("commitVersion") !== COMMIT_VERSION ||
      field("digestConvention") !== ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION ||
      typeof field("receiptId") !== "string" || !HASH.test(field("receiptId") as string) ||
      typeof field("receiptSha256") !== "string" || !HASH.test(field("receiptSha256") as string) ||
      !Number.isSafeInteger(field("receiptBytes")) || (field("receiptBytes") as number) < 2 ||
      (field("receiptBytes") as number) > ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES ||
      field("state") !== "committed"
    ) failure("RECEIPT_INVALID");
    return Object.freeze({
      schemaVersion: 1,
      commitVersion: COMMIT_VERSION,
      digestConvention: ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
      receiptId: field("receiptId") as string,
      receiptSha256: field("receiptSha256") as string,
      receiptBytes: field("receiptBytes") as number,
      state: "committed",
    });
  } catch (error) {
    if (error instanceof AnthropicValidationReceiptError) throw error;
    failure("RECEIPT_INVALID");
  }
}

function commitDocument(value: unknown): string {
  const parsed = exactCommit(value);
  const text = `${toCanonicalJson(parsed, "anthropicValidationSuccessReceiptCommit")}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_COMMIT_BYTES) failure("RECEIPT_INVALID");
  return text;
}

async function defaultDirectoryDurability(directory: string, target: string): Promise<void> {
  // Node cannot portably fsync a Windows directory handle. Reopening and
  // flushing the exact newly linked target is the repository's bounded
  // Windows durability barrier; POSIX additionally flushes the directory.
  const path = process.platform === "win32" ? target : directory;
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function safeRoot(input: string): string {
  if (
    typeof input !== "string" || !isAbsolute(input) || input.length === 0 ||
    input.length > MAX_ROOT_LENGTH || input.includes("\u0000") || input.startsWith("file:")
  ) failure("RECEIPT_UNAVAILABLE");
  return resolve(input);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function anthropicValidationReceiptRoot(appDataPath: string, appName: string): string {
  const parent = resolve(appDataPath);
  const target = resolve(parent, appName, "credential-setup", "anthropic-validation", "success-receipts-v1");
  if (!target.startsWith(parent + sep)) failure("RECEIPT_UNAVAILABLE");
  return target;
}

export function createFileAnthropicValidationSuccessReceiptStore(options: Readonly<{
  root: string;
  durability?: AnthropicValidationReceiptDurabilityPort;
  /** Test-only race seam; production composition never supplies this hook. */
  testingHooks?: Readonly<{
    afterReadBeforePathIdentity?(path: string): Promise<void>;
  }>;
}>): AnthropicValidationSuccessReceiptStore {
  const root = safeRoot(options.root);
  const durability = options.durability ?? Object.freeze({ syncDirectoryEntry: defaultDirectoryDurability });
  let sequence: Promise<void> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = sequence.then(work, work);
    sequence = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const namedPath = (receiptId: string, suffix: "receipt" | "commit"): string => {
    if (!HASH.test(receiptId)) failure("RECEIPT_INVALID");
    const target = resolve(root, `${receiptId}.${suffix}.json`);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) failure("RECEIPT_UNAVAILABLE");
    return target;
  };

  const assertRoot = async (create: boolean): Promise<ReceiptRootBinding> => {
    try {
      if (create) await mkdir(root, { recursive: true, mode: 0o700 });
      const observed = await lstat(root);
      if (!observed.isDirectory() || observed.isSymbolicLink()) failure("RECEIPT_UNAVAILABLE");
      const resolved = await realpath(root);
      return Object.freeze({ identity: observed, realPath: resolved });
    } catch (error) {
      if (error instanceof AnthropicValidationReceiptError) throw error;
      if (!create && errorCode(error) === "ENOENT") failure("RECEIPT_MISSING");
      failure("RECEIPT_UNAVAILABLE");
    }
  };

  const assertRootBound = async (expected: ReceiptRootBinding): Promise<void> => {
    try {
      const observed = await lstat(root);
      if (
        !observed.isDirectory() || observed.isSymbolicLink() ||
        !sameIdentity(observed, expected.identity) ||
        !samePath(await realpath(root), expected.realPath)
      ) failure("RECEIPT_UNAVAILABLE");
    } catch (error) {
      if (error instanceof AnthropicValidationReceiptError) throw error;
      failure("RECEIPT_UNAVAILABLE");
    }
  };

  const promoteCreateOnly = async (
    target: string,
    text: string,
    rootBinding: ReceiptRootBinding,
  ): Promise<void> => {
    const temporary = join(root, `.receipt-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;
      const temporaryIdentity = await lstat(temporary);
      if (!temporaryIdentity.isFile() || temporaryIdentity.isSymbolicLink()) failure("RECEIPT_UNAVAILABLE");
      await assertRootBound(rootBinding);
      await link(temporary, target);
      const promoted = await lstat(target);
      if (
        !promoted.isFile() || promoted.isSymbolicLink() ||
        !sameIdentity(promoted, temporaryIdentity)
      ) failure("RECEIPT_UNAVAILABLE");
      await durability.syncDirectoryEntry(root, target);
      await assertRootBound(rootBinding);
      const durable = await lstat(target);
      if (
        !durable.isFile() || durable.isSymbolicLink() ||
        !sameIdentity(durable, temporaryIdentity)
      ) failure("RECEIPT_UNAVAILABLE");
    } catch (error) {
      if (error instanceof AnthropicValidationReceiptError) throw error;
      if (errorCode(error) === "EEXIST") failure("RECEIPT_CONFLICT");
      failure("RECEIPT_UNAVAILABLE");
    } finally {
      try { await handle?.close(); } catch { /* bounded cleanup */ }
      try { await unlink(temporary); } catch { /* a sanitized temp is safe to preserve for recovery */ }
    }
  };

  const readExact = async (path: string, maximum: number, missingCode: "RECEIPT_MISSING" | "RECEIPT_INCOMPLETE"): Promise<Buffer> => {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const observed = await lstat(path);
      if (!observed.isFile() || observed.isSymbolicLink() || observed.size < 2 || observed.size > maximum) failure("RECEIPT_INVALID");
      handle = await open(path, "r");
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== observed.dev || before.ino !== observed.ino || before.size !== observed.size) failure("RECEIPT_INVALID");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) failure("RECEIPT_INVALID");
        offset += read.bytesRead;
      }
      const extra = Buffer.alloc(1);
      try {
        if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) failure("RECEIPT_INVALID");
      } finally { extra.fill(0); }
      const after = await handle.stat();
      if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) failure("RECEIPT_INVALID");
      await options.testingHooks?.afterReadBeforePathIdentity?.(path);
      let namedAfter: Awaited<ReturnType<typeof lstat>>;
      try { namedAfter = await lstat(path); }
      catch { failure("RECEIPT_INVALID"); }
      if (
        !namedAfter.isFile() || namedAfter.isSymbolicLink() ||
        namedAfter.size !== after.size || namedAfter.dev !== after.dev ||
        namedAfter.ino !== after.ino
      ) failure("RECEIPT_INVALID");
      return bytes;
    } catch (error) {
      if (error instanceof AnthropicValidationReceiptError) throw error;
      if (errorCode(error) === "ENOENT") failure(missingCode);
      failure("RECEIPT_UNAVAILABLE");
    } finally {
      try { await handle?.close(); } catch { /* bounded read cleanup */ }
    }
  };

  const readCommitted = async (
    receiptId: string,
    expected: Readonly<{ receiptSha256?: string; candidateHead?: string; candidateTree?: string; candidateManifestAggregate?: string }> = {},
  ): Promise<AnthropicValidationSuccessReceiptProjection> => {
    const rootBinding = await assertRoot(false);
    if (
      (expected.receiptSha256 !== undefined && !HASH.test(expected.receiptSha256)) ||
      (expected.candidateHead !== undefined && !GIT_OBJECT.test(expected.candidateHead)) ||
      (expected.candidateTree !== undefined && !GIT_OBJECT.test(expected.candidateTree)) ||
      (expected.candidateManifestAggregate !== undefined && !HASH.test(expected.candidateManifestAggregate))
    ) failure("RECEIPT_INVALID");
    const commitBytes = await readExact(namedPath(receiptId, "commit"), MAX_COMMIT_BYTES, "RECEIPT_INCOMPLETE");
    let commit: ReceiptCommit;
    try {
      const text = UTF8.decode(commitBytes);
      commit = exactCommit(JSON.parse(text) as unknown);
      if (text !== commitDocument(commit)) failure("RECEIPT_INVALID");
    } catch (error) {
      if (error instanceof AnthropicValidationReceiptError) throw error;
      failure("RECEIPT_INVALID");
    } finally { commitBytes.fill(0); }
    if (commit.receiptId !== receiptId || (expected.receiptSha256 !== undefined && commit.receiptSha256 !== expected.receiptSha256)) failure("RECEIPT_INVALID");
    const receiptBytes = await readExact(namedPath(receiptId, "receipt"), ANTHROPIC_SUCCESS_RECEIPT_MAX_BYTES, "RECEIPT_INCOMPLETE");
    try {
      const parsed = parseCanonicalAnthropicValidationSuccessReceipt(receiptBytes);
      if (
        parsed.sha256 !== commit.receiptSha256 || receiptBytes.byteLength !== commit.receiptBytes ||
        parsed.receipt.authorizationPacketSha256 !== receiptId ||
        (expected.candidateHead !== undefined && parsed.receipt.candidateHead !== expected.candidateHead) ||
        (expected.candidateTree !== undefined && parsed.receipt.candidateTree !== expected.candidateTree) ||
        (expected.candidateManifestAggregate !== undefined && parsed.receipt.candidateManifestAggregate !== expected.candidateManifestAggregate)
      ) failure("RECEIPT_INVALID");
      await assertRootBound(rootBinding);
      return Object.freeze({
        receipt: parsed.receipt,
        reference: Object.freeze({ receiptId, receiptSha256: parsed.sha256 }),
        canonicalDocument: parsed.canonicalDocument,
      });
    } finally { receiptBytes.fill(0); }
  };

  return Object.freeze({
    async commit(value: unknown) {
      return await enqueue(async () => {
        const receipt = parseAnthropicValidationSuccessReceipt(value);
        const receiptDocument = serializeAnthropicValidationSuccessReceipt(receipt);
        const receiptBytes = Buffer.byteLength(receiptDocument, "utf8");
        const receiptSha256 = createHash("sha256").update(receiptDocument, "utf8").digest("hex");
        const receiptId = receipt.authorizationPacketSha256;
        const commit: ReceiptCommit = Object.freeze({
          schemaVersion: 1,
          commitVersion: COMMIT_VERSION,
          digestConvention: ANTHROPIC_SUCCESS_RECEIPT_DIGEST_CONVENTION,
          receiptId,
          receiptSha256,
          receiptBytes,
          state: "committed",
        });
        const rootBinding = await assertRoot(true);
        await promoteCreateOnly(namedPath(receiptId, "receipt"), receiptDocument, rootBinding);
        await promoteCreateOnly(namedPath(receiptId, "commit"), commitDocument(commit), rootBinding);
        return Object.freeze({ receiptId, receiptSha256 });
      });
    },
    async readCommitted(
      receiptId: string,
      expected: Readonly<{ receiptSha256?: string; candidateHead?: string; candidateTree?: string; candidateManifestAggregate?: string }> = {},
    ) {
      return await enqueue(async () => await readCommitted(receiptId, expected));
    },
  });
}

export function createMemoryAnthropicValidationSuccessReceiptStore(): AnthropicValidationSuccessReceiptStore & {
  readonly commits: number;
} {
  const records = new Map<string, AnthropicValidationSuccessReceiptProjection>();
  let commits = 0;
  return Object.freeze({
    get commits() { return commits; },
    async commit(value: unknown) {
      const receipt = parseAnthropicValidationSuccessReceipt(value);
      const canonicalDocument = serializeAnthropicValidationSuccessReceipt(receipt);
      const receiptId = receipt.authorizationPacketSha256;
      if (records.has(receiptId)) failure("RECEIPT_CONFLICT");
      const receiptSha256 = createHash("sha256").update(canonicalDocument, "utf8").digest("hex");
      const reference = Object.freeze({ receiptId, receiptSha256 });
      records.set(receiptId, Object.freeze({ receipt, reference, canonicalDocument }));
      commits += 1;
      return reference;
    },
    async readCommitted(
      receiptId: string,
      expected: Readonly<{ receiptSha256?: string; candidateHead?: string; candidateTree?: string; candidateManifestAggregate?: string }> = {},
    ) {
      const projected = records.get(receiptId);
      if (projected === undefined) failure("RECEIPT_MISSING");
      if (
        (expected.receiptSha256 !== undefined && projected.reference.receiptSha256 !== expected.receiptSha256) ||
        (expected.candidateHead !== undefined && projected.receipt.candidateHead !== expected.candidateHead) ||
        (expected.candidateTree !== undefined && projected.receipt.candidateTree !== expected.candidateTree) ||
        (expected.candidateManifestAggregate !== undefined && projected.receipt.candidateManifestAggregate !== expected.candidateManifestAggregate)
      ) failure("RECEIPT_INVALID");
      return projected;
    },
  });
}
