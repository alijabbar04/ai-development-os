import { randomBytes } from "node:crypto";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import { controlFail, errorCode } from "./errors.js";
import {
  parseConnectionDescriptor,
  parseInstanceLock,
  serializeConnectionDescriptor,
  serializeInstanceLock,
  type ConnectionDescriptor,
  type InstanceLock,
} from "./contracts.js";
import { parseJsonDocument } from "./structural.js";

export const CONNECTION_DESCRIPTOR_FILE = "connection.v1.json" as const;
export const INSTANCE_LOCK_FILE = "instance.v1.lock" as const;
export const MAX_ARTIFACT_BYTES = 4_096;

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number;
}

export interface ArtifactLease {
  readonly kind: "descriptor" | "lock";
  readonly processId: number;
  readonly startNonce: string;
  readonly identity: FileIdentity;
}

export interface ReadArtifact<T> {
  readonly value: T;
  readonly lease: ArtifactLease;
}

interface RootBinding {
  readonly identity: FileIdentity;
  readonly realPath: string;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function identity(stats: Stats): FileIdentity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino, size: stats.size });
}

function sameIdentity(left: FileIdentity, stats: Stats): boolean {
  return left.dev === stats.dev && left.ino === stats.ino && left.size === stats.size;
}

function sameNodeIdentity(left: FileIdentity, stats: Stats): boolean {
  return left.dev === stats.dev && left.ino === stats.ino;
}

function safeAbsoluteRoot(input: string): string {
  if (
    typeof input !== "string" || input.length === 0 || input.length > 1_024 ||
    input.includes("\u0000") || input.startsWith("file:") || !isAbsolute(input) ||
    /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/u.test(input)
  ) controlFail("STORAGE_UNSAFE");
  if (process.platform === "win32") {
    const tail = input.slice(parsePath(input).root.length);
    if (tail.includes(":")) controlFail("STORAGE_UNSAFE");
  }
  return resolve(input);
}

async function syncDirectoryEntry(directory: string, target: string): Promise<void> {
  const selected = process.platform === "win32" ? target : directory;
  const handle = await open(selected, process.platform === "win32" ? "r+" : "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export interface ControlArtifactStore {
  prepare(): Promise<void>;
  writeDescriptor(value: unknown): Promise<ArtifactLease>;
  writeLock(value: unknown): Promise<ArtifactLease>;
  readDescriptor(): Promise<ReadArtifact<ConnectionDescriptor>>;
  readLock(): Promise<ReadArtifact<InstanceLock>>;
  removeOwned(lease: ArtifactLease): Promise<void>;
}

export function createControlArtifactStore(options: Readonly<{
  root: string;
  syncEntry?: (directory: string, target: string) => Promise<void>;
}>): ControlArtifactStore {
  const root = safeAbsoluteRoot(options.root);
  const syncEntry = options.syncEntry ?? syncDirectoryEntry;
  let binding: RootBinding | null = null;

  const targetFor = (kind: ArtifactLease["kind"]): string => {
    const target = resolve(root, kind === "descriptor" ? CONNECTION_DESCRIPTOR_FILE : INSTANCE_LOCK_FILE);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) controlFail("STORAGE_UNSAFE");
    return target;
  };

  const inspectComponents = async (): Promise<RootBinding> => {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const rootPrefix = parsePath(root).root;
      const remainder = root.slice(rootPrefix.length).split(/[\\/]+/u).filter(Boolean);
      let cursor = rootPrefix;
      for (const component of remainder) {
        cursor = resolve(cursor, component);
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) controlFail("STORAGE_UNSAFE");
      }
      const observed = await lstat(root);
      const resolved = await realpath(root);
      if (!observed.isDirectory() || observed.isSymbolicLink() || !samePath(resolved, root)) {
        controlFail("STORAGE_UNSAFE");
      }
      return Object.freeze({ identity: identity(observed), realPath: resolved });
    } catch (error) {
      if (error instanceof Error && error.name === "ControlServiceError") throw error;
      controlFail("STORAGE_UNSAFE");
    }
  };

  const assertBound = async (): Promise<RootBinding> => {
    const expected = binding ?? await inspectComponents();
    binding ??= expected;
    try {
      const observed = await lstat(root);
      if (
        !observed.isDirectory() || observed.isSymbolicLink() ||
        !sameNodeIdentity(expected.identity, observed) || !samePath(await realpath(root), expected.realPath)
      ) controlFail("STORAGE_UNSAFE");
      return expected;
    } catch (error) {
      if (error instanceof Error && error.name === "ControlServiceError") throw error;
      controlFail("STORAGE_UNSAFE");
    }
  };

  const promoteCreateOnly = async (kind: ArtifactLease["kind"], value: ConnectionDescriptor | InstanceLock, text: string): Promise<ArtifactLease> => {
    await assertBound();
    const target = targetFor(kind);
    const temporary = resolve(root, `.control-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let linked = false;
    let promotedIdentity: FileIdentity | null = null;
    try {
      if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) controlFail("ARTIFACT_INVALID");
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      const temporaryStats = await handle.stat();
      await handle.close();
      handle = null;
      if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink()) controlFail("STORAGE_UNSAFE");
      await assertBound();
      await link(temporary, target);
      linked = true;
      const promoted = await lstat(target);
      if (!promoted.isFile() || promoted.isSymbolicLink() || !sameIdentity(identity(temporaryStats), promoted)) {
        controlFail("STORAGE_UNSAFE");
      }
      promotedIdentity = identity(promoted);
      await syncEntry(root, target);
      await assertBound();
      const durable = await lstat(target);
      if (!sameIdentity(identity(promoted), durable)) controlFail("STORAGE_UNSAFE");
      return Object.freeze({ kind, processId: value.processId, startNonce: value.startNonce, identity: identity(durable) });
    } catch (error) {
      if (linked && promotedIdentity !== null) {
        try {
          const current = await lstat(target);
          if (sameIdentity(promotedIdentity, current)) await unlink(target);
        } catch { /* remove only the exact just-promoted identity */ }
      }
      if (error instanceof Error && error.name === "ControlServiceError") throw error;
      if (errorCode(error) === "EEXIST") controlFail("ARTIFACT_CONFLICT");
      controlFail("STORAGE_UNSAFE");
    } finally {
      try { await handle?.close(); } catch { /* exact temporary cleanup only */ }
      try { await unlink(temporary); } catch { /* no directory scan or broad cleanup */ }
    }
  };

  const readExact = async <T>(kind: ArtifactLease["kind"], parser: (value: unknown) => T): Promise<ReadArtifact<T>> => {
    await assertBound();
    const target = targetFor(kind);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const named = await lstat(target);
      if (!named.isFile() || named.isSymbolicLink() || named.size < 2 || named.size > MAX_ARTIFACT_BYTES) {
        controlFail("ARTIFACT_INVALID");
      }
      handle = await open(target, "r");
      const opened = await handle.stat();
      if (!sameIdentity(identity(named), opened)) controlFail("ARTIFACT_INVALID");
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) controlFail("ARTIFACT_INVALID");
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) controlFail("ARTIFACT_INVALID");
      const after = await handle.stat();
      const namedAfter = await lstat(target);
      if (!sameIdentity(identity(opened), after) || !sameIdentity(identity(after), namedAfter)) controlFail("ARTIFACT_INVALID");
      const value = parser(parseJsonDocument(bytes));
      const owner = value as T & { readonly processId: number; readonly startNonce: string };
      return Object.freeze({
        value,
        lease: Object.freeze({ kind, processId: owner.processId, startNonce: owner.startNonce, identity: identity(namedAfter) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ControlServiceError") throw error;
      if (errorCode(error) === "ENOENT") controlFail("ARTIFACT_MISSING");
      controlFail("ARTIFACT_INVALID");
    } finally {
      try { await handle?.close(); } catch { /* bounded exact handle */ }
    }
  };

  return Object.freeze({
    async prepare() { binding = await inspectComponents(); },
    async writeDescriptor(value: unknown) {
      const parsed = parseConnectionDescriptor(value);
      return await promoteCreateOnly("descriptor", parsed, serializeConnectionDescriptor(parsed));
    },
    async writeLock(value: unknown) {
      const parsed = parseInstanceLock(value);
      return await promoteCreateOnly("lock", parsed, serializeInstanceLock(parsed));
    },
    async readDescriptor() { return await readExact("descriptor", parseConnectionDescriptor); },
    async readLock() { return await readExact("lock", parseInstanceLock); },
    async removeOwned(lease: ArtifactLease) {
      await assertBound();
      const current = lease.kind === "descriptor" ? await this.readDescriptor() : await this.readLock();
      if (
        current.lease.processId !== lease.processId || current.lease.startNonce !== lease.startNonce ||
        current.lease.identity.dev !== lease.identity.dev || current.lease.identity.ino !== lease.identity.ino ||
        current.lease.identity.size !== lease.identity.size
      ) controlFail("ARTIFACT_FOREIGN");
      await unlink(targetFor(lease.kind));
      await assertBound();
    },
  });
}
