import { mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArtifactId } from "@ai-dev-os/domain";
import {
  ArtifactStoreError,
  DEFAULT_MAX_WRITE_BYTES,
  DEFAULT_READ_BYTES_LIMIT,
  STORE_LAYOUT_VERSION,
  collectBytes,
  contentKeyEquals,
  createIncrementalDigest,
  ensureByteChunk,
  bytesToStream,
  isArtifactStoreError,
  parseContentKey,
  systemClock,
  type ArtifactByteStore,
  type ByteStream,
  type Clock,
  type ContentKey,
  type ContentLocation,
  type ObjectStat,
  type ReadBytesOptions,
  type ReadOptions,
  type TempCleanupOptions,
  type TempCleanupReport,
  type WriteOptions,
  type WriteResult,
} from "@ai-dev-os/artifact-store";

export interface LocalArtifactStoreOptions {
  /** Absolute directory that the store owns. Created when missing. */
  readonly root: string;
  readonly clock?: Clock;
  /** Temp-name entropy source; must return 32 lowercase hex characters. */
  readonly idSource?: () => string;
  /** Default cap applied to writes without an explicit maxSizeBytes. */
  readonly defaultMaxWriteBytes?: number;
  /**
   * "flush" (default): fsync the temp file before promotion and
   * best-effort fsync the parent directory after rename on POSIX.
   * "fast": skip fsync; contents reach disk at the OS's discretion.
   */
  readonly durability?: "flush" | "fast";
}

const LAYOUT_DIRECTORY = `v${STORE_LAYOUT_VERSION}`;
const TEMP_DIRECTORY = "tmp";
export const TEMP_FILE_PATTERN = /^w-[0-9a-f]{32}\.tmp$/;
const ID_SOURCE_PATTERN = /^[0-9a-f]{32}$/;
const READ_CHUNK_BYTES = 65_536;
const MAX_ROOT_PATH_LENGTH = 1_024;
const MAX_SAFE_SIZE = Number.MAX_SAFE_INTEGER;

function invalidConfiguration(message: string): ArtifactStoreError {
  return new ArtifactStoreError("INVALID_CONFIGURATION", message);
}

function sysCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** Wraps unexpected filesystem failures without leaking paths. */
function fsFailure(
  error: unknown,
  code: "WRITE_INTERRUPTED" | "UNSAFE_FILESYSTEM_STATE" | "CLEANUP_FAILED",
  message: string,
): ArtifactStoreError {
  if (isArtifactStoreError(error)) {
    return error;
  }
  return new ArtifactStoreError(code, message, { sysCode: sysCode(error) });
}

function ensureSafeSizeOption(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw invalidConfiguration(`${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

export function createLocalArtifactStore(
  options: LocalArtifactStoreOptions,
): Promise<ArtifactByteStore> {
  return LocalStore.open(options);
}

class LocalStore implements ArtifactByteStore {
  readonly #root: string;
  readonly #tempDir: string;
  readonly #clock: Clock;
  readonly #idSource: () => string;
  readonly #defaultMaxWriteBytes: number;
  readonly #flush: boolean;
  #closed = false;
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #openHandles = new Set<FileHandle>();

  private constructor(options: {
    root: string;
    tempDir: string;
    clock: Clock;
    idSource: () => string;
    defaultMaxWriteBytes: number;
    flush: boolean;
  }) {
    this.#root = options.root;
    this.#tempDir = options.tempDir;
    this.#clock = options.clock;
    this.#idSource = options.idSource;
    this.#defaultMaxWriteBytes = options.defaultMaxWriteBytes;
    this.#flush = options.flush;
  }

  static async open(options: LocalArtifactStoreOptions): Promise<LocalStore> {
    const root = options?.root;
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.length > MAX_ROOT_PATH_LENGTH ||
      root.includes("\u0000") ||
      root.startsWith("file:")
    ) {
      throw invalidConfiguration("The store root must be a plain filesystem path.");
    }
    if (!isAbsolute(root)) {
      throw invalidConfiguration("The store root must be an absolute path.");
    }
    const durability = options.durability ?? "flush";
    if (durability !== "flush" && durability !== "fast") {
      throw invalidConfiguration('durability must be "flush" or "fast".');
    }
    const defaultMaxWriteBytes = ensureSafeSizeOption(
      options.defaultMaxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
      "defaultMaxWriteBytes",
      1,
    );

    let pinnedRoot: string;
    try {
      await mkdir(resolve(root), { recursive: true });
      pinnedRoot = await realpath(resolve(root));
      await mkdir(join(pinnedRoot, LAYOUT_DIRECTORY), { recursive: true });
      await mkdir(join(pinnedRoot, TEMP_DIRECTORY), { recursive: true });
    } catch (error) {
      throw new ArtifactStoreError(
        "INVALID_CONFIGURATION",
        "The store root could not be created or resolved.",
        { sysCode: sysCode(error) },
      );
    }

    return new LocalStore({
      root: pinnedRoot,
      tempDir: join(pinnedRoot, TEMP_DIRECTORY),
      clock: options.clock ?? systemClock,
      idSource: options.idSource ?? (() => randomBytes(16).toString("hex")),
      defaultMaxWriteBytes,
      flush: durability === "flush",
    });
  }

  // -- lifecycle ------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) {
      throw new ArtifactStoreError("STORE_CLOSED", "The artifact store is closed.");
    }
  }

  /**
   * Tracks an in-flight mutating operation. The promise returned here is
   * the exact promise the caller receives, and close() awaits these same
   * promises, so caller continuations (attached first) always observe
   * completion before close() resolves.
   */
  #track<T>(work: () => Promise<T>): Promise<T> {
    const tracked = (async () => {
      this.#assertOpen();
      return await work();
    })().finally(() => {
      this.#inflight.delete(tracked);
    }) as Promise<T>;
    this.#inflight.add(tracked);
    return tracked;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled([...this.#inflight]);
    for (const handle of [...this.#openHandles]) {
      this.#openHandles.delete(handle);
      try {
        await handle.close();
      } catch {
        // Best effort: the stream consuming this handle will surface
        // STORE_CLOSED on its next pull.
      }
    }
  }

  // -- paths ----------------------------------------------------------------

  location(key: ContentKey): ContentLocation {
    const parsed = parseContentKey(key);
    return Object.freeze({
      layoutVersion: STORE_LAYOUT_VERSION,
      relativePath: `${LAYOUT_DIRECTORY}/${parsed.algorithm}/${parsed.hex.slice(0, 2)}/${parsed.hex}`,
    });
  }

  #objectPath(key: ContentKey): string {
    const absolute = join(
      this.#root,
      LAYOUT_DIRECTORY,
      key.algorithm,
      key.hex.slice(0, 2),
      key.hex,
    );
    if (!absolute.startsWith(this.#root + sep)) {
      throw new ArtifactStoreError(
        "UNSAFE_FILESYSTEM_STATE",
        "The computed object path escaped the store root.",
      );
    }
    return absolute;
  }

  /**
   * Creates the object's parent directory and verifies that, after symlink
   * and junction resolution, it still lives inside the pinned root. This
   * check happens at use time; the remaining check-to-use window is a
   * documented portable limitation.
   */
  async #ensureSafeParent(objectPath: string): Promise<void> {
    const parent = dirname(objectPath);
    try {
      await mkdir(parent, { recursive: true });
      const resolved = await realpath(parent);
      if (resolved !== this.#root && !resolved.startsWith(this.#root + sep)) {
        throw new ArtifactStoreError(
          "UNSAFE_FILESYSTEM_STATE",
          "An object directory resolves outside the store root.",
        );
      }
    } catch (error) {
      throw fsFailure(
        error,
        "UNSAFE_FILESYSTEM_STATE",
        "The object directory could not be prepared safely.",
      );
    }
  }

  #tempPath(): string {
    const id = this.#idSource();
    if (typeof id !== "string" || !ID_SOURCE_PATTERN.test(id)) {
      throw invalidConfiguration("The idSource must return 32 lowercase hex characters.");
    }
    return join(this.#tempDir, `w-${id}.tmp`);
  }

  // -- writes ---------------------------------------------------------------

  write(source: ByteStream, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#track(() => this.#write(source, options));
  }

  writeBytes(value: Uint8Array | string, options: WriteOptions = {}): Promise<WriteResult> {
    return this.write(bytesToStream(value), options);
  }

  async #write(source: ByteStream, options: WriteOptions): Promise<WriteResult> {
    const expectedKey = options.expectedKey === undefined ? null : parseContentKey(options.expectedKey);
    const algorithm = expectedKey?.algorithm ?? options.algorithm ?? "sha-256";
    if (algorithm !== "sha-256" && algorithm !== "sha-512") {
      throw invalidConfiguration("The digest algorithm must be sha-256 or sha-512.");
    }
    if (expectedKey !== null && options.algorithm !== undefined && options.algorithm !== expectedKey.algorithm) {
      throw invalidConfiguration("expectedKey and algorithm disagree.");
    }
    const maxSizeBytes =
      options.maxSizeBytes === undefined
        ? this.#defaultMaxWriteBytes
        : ensureSafeSizeOption(options.maxSizeBytes, "maxSizeBytes", 0);
    const expectedSizeBytes =
      options.expectedSizeBytes === undefined
        ? null
        : ensureSafeSizeOption(options.expectedSizeBytes, "expectedSizeBytes", 0);
    const artifactId =
      options.artifactId === undefined || options.artifactId === null
        ? null
        : parseArtifactId(options.artifactId, "artifactId");

    const tempPath = await this.#createTempFile();
    let handle = tempPath.handle;
    const digest = createIncrementalDigest(algorithm);
    let sizeBytes = 0;

    try {
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        // Source failures propagate to the caller unchanged.
        const step = await iterator.next();
        if (step.done === true) {
          break;
        }
        const chunk = ensureByteChunk(step.value);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxSizeBytes || sizeBytes > MAX_SAFE_SIZE) {
          try {
            await iterator.return?.();
          } catch {
            // The source's cancellation failure must not mask the limit error.
          }
          throw new ArtifactStoreError(
            "SIZE_LIMIT_EXCEEDED",
            "The stream exceeded the maximum write size.",
            { maxSizeBytes },
          );
        }
        digest.update(chunk);
        try {
          await handle.write(chunk);
        } catch (error) {
          throw fsFailure(error, "WRITE_INTERRUPTED", "Writing to temporary storage failed.");
        }
      }

      try {
        if (this.#flush) {
          await handle.sync();
        }
        await handle.close();
      } catch (error) {
        throw fsFailure(error, "WRITE_INTERRUPTED", "Flushing temporary storage failed.");
      } finally {
        this.#openHandles.delete(handle);
        handle = null as never;
      }

      if (expectedSizeBytes !== null && sizeBytes !== expectedSizeBytes) {
        throw new ArtifactStoreError("SIZE_MISMATCH", "The stream size did not match the expectation.", {
          expectedSizeBytes,
          actualSizeBytes: sizeBytes,
        });
      }
      const key = digest.finish();
      if (expectedKey !== null && !contentKeyEquals(key, expectedKey)) {
        throw new ArtifactStoreError(
          "DIGEST_MISMATCH",
          "The stream digest did not match the expectation.",
          { algorithm, expectedHex: expectedKey.hex, actualHex: key.hex },
        );
      }

      const deduplicated = await this.#promote(tempPath.path, key, sizeBytes);
      return Object.freeze({
        key,
        sizeBytes,
        location: this.location(key),
        deduplicated,
        artifactId,
      });
    } finally {
      if (handle !== null && handle !== undefined) {
        this.#openHandles.delete(handle);
        try {
          await handle.close();
        } catch {
          // Best effort; the temp file is removed below regardless.
        }
      }
      await unlink(tempPath.path).catch(() => undefined);
    }
  }

  async #createTempFile(): Promise<{ readonly path: string; readonly handle: FileHandle }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const path = this.#tempPath();
      try {
        const handle = await open(path, "wx");
        this.#openHandles.add(handle);
        return { path, handle };
      } catch (error) {
        if (sysCode(error) === "EEXIST") {
          continue;
        }
        throw fsFailure(error, "WRITE_INTERRUPTED", "A temporary file could not be created.");
      }
    }
    throw new ArtifactStoreError(
      "UNSAFE_FILESYSTEM_STATE",
      "Exclusive temporary-file creation kept colliding.",
    );
  }

  /**
   * Promotes a fully verified temp file to its content-addressed location.
   * Returns true when identical content already existed (deduplicated).
   * Under a concurrent identical write, rename may replace the freshly
   * promoted identical object (atomic on both platforms), so two racing
   * writers can both report newly-stored; bytes are identical either way,
   * and different bytes can never collide because the path is the digest.
   */
  async #promote(tempFile: string, key: ContentKey, sizeBytes: number): Promise<boolean> {
    const objectPath = this.#objectPath(key);
    const existing = await this.#statObject(objectPath, key, sizeBytes);
    if (existing) {
      return true;
    }
    await this.#ensureSafeParent(objectPath);
    try {
      await rename(tempFile, objectPath);
    } catch (error) {
      // Windows can refuse to replace a concurrently promoted object.
      if (sysCode(error) === "EEXIST" || sysCode(error) === "EPERM") {
        if (await this.#statObject(objectPath, key, sizeBytes)) {
          return true;
        }
      }
      throw fsFailure(error, "WRITE_INTERRUPTED", "Promoting the object failed.");
    }
    if (this.#flush && process.platform !== "win32") {
      // Best-effort directory-entry durability; unsupported on Windows.
      try {
        const dirHandle = await open(dirname(objectPath), "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // Documented best-effort behavior.
      }
    }
    return false;
  }

  async #statObject(objectPath: string, key: ContentKey, expectedSize: number | null): Promise<boolean> {
    try {
      const info = await stat(objectPath);
      if (!info.isFile()) {
        throw new ArtifactStoreError(
          "UNSAFE_FILESYSTEM_STATE",
          "The object location is occupied by a non-file entry.",
          { algorithm: key.algorithm, hex: key.hex },
        );
      }
      if (expectedSize !== null && info.size !== expectedSize) {
        throw new ArtifactStoreError(
          "UNSAFE_FILESYSTEM_STATE",
          "An existing object with the same digest has a different size.",
          { algorithm: key.algorithm, hex: key.hex },
        );
      }
      return true;
    } catch (error) {
      if (sysCode(error) === "ENOENT") {
        return false;
      }
      throw fsFailure(error, "UNSAFE_FILESYSTEM_STATE", "The object location could not be inspected.");
    }
  }

  // -- reads ----------------------------------------------------------------

  async openRead(key: ContentKey, options: ReadOptions = {}): Promise<ByteStream> {
    const parsed = parseContentKey(key);
    this.#assertOpen();
    const objectPath = this.#objectPath(parsed);
    let handle: FileHandle;
    try {
      handle = await open(objectPath, "r");
    } catch (error) {
      if (sysCode(error) === "ENOENT") {
        throw new ArtifactStoreError("OBJECT_NOT_FOUND", "The object does not exist.", {
          algorithm: parsed.algorithm,
          hex: parsed.hex,
        });
      }
      throw fsFailure(error, "UNSAFE_FILESYSTEM_STATE", "The object could not be opened.");
    }
    this.#openHandles.add(handle);
    const verify = options.verify === true;
    const digest = verify ? createIncrementalDigest(parsed.algorithm) : null;
    const store = this;

    return (async function* readStream(): ByteStream {
      try {
        const buffer = new Uint8Array(READ_CHUNK_BYTES);
        for (;;) {
          if (store.#closed) {
            throw new ArtifactStoreError("STORE_CLOSED", "The artifact store is closed.");
          }
          let bytesRead: number;
          try {
            const result = await handle.read(buffer, 0, buffer.byteLength, null);
            bytesRead = result.bytesRead;
          } catch (error) {
            if (store.#closed) {
              throw new ArtifactStoreError("STORE_CLOSED", "The artifact store is closed.");
            }
            throw fsFailure(error, "UNSAFE_FILESYSTEM_STATE", "Reading the object failed.");
          }
          if (bytesRead === 0) {
            break;
          }
          const chunk = buffer.slice(0, bytesRead);
          digest?.update(chunk);
          yield chunk;
        }
        if (digest !== null) {
          const actual = digest.finish();
          if (!contentKeyEquals(actual, parsed)) {
            throw new ArtifactStoreError(
              "OBJECT_CORRUPTED",
              "The stored object failed digest verification.",
              { algorithm: parsed.algorithm, expectedHex: parsed.hex, actualHex: actual.hex },
            );
          }
        }
      } finally {
        store.#openHandles.delete(handle);
        try {
          await handle.close();
        } catch {
          // Already closed by store.close(); nothing further to release.
        }
      }
    })();
  }

  async readBytes(key: ContentKey, options: ReadBytesOptions = {}): Promise<Uint8Array> {
    const maxBytes =
      options.maxBytes === undefined
        ? DEFAULT_READ_BYTES_LIMIT
        : ensureSafeSizeOption(options.maxBytes, "maxBytes", 0);
    const info = await this.stat(key);
    if (info === null) {
      const parsed = parseContentKey(key);
      throw new ArtifactStoreError("OBJECT_NOT_FOUND", "The object does not exist.", {
        algorithm: parsed.algorithm,
        hex: parsed.hex,
      });
    }
    if (info.sizeBytes > maxBytes) {
      throw new ArtifactStoreError(
        "SIZE_LIMIT_EXCEEDED",
        "The object exceeds the caller-provided byte bound.",
        { maxBytes, sizeBytes: info.sizeBytes },
      );
    }
    const readOptions: ReadOptions = options.verify === undefined ? {} : { verify: options.verify };
    const stream = await this.openRead(key, readOptions);
    return collectBytes(stream, maxBytes);
  }

  async exists(key: ContentKey): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: ContentKey): Promise<ObjectStat | null> {
    const parsed = parseContentKey(key);
    this.#assertOpen();
    const objectPath = this.#objectPath(parsed);
    try {
      const info = await stat(objectPath);
      if (!info.isFile()) {
        throw new ArtifactStoreError(
          "UNSAFE_FILESYSTEM_STATE",
          "The object location is occupied by a non-file entry.",
          { algorithm: parsed.algorithm, hex: parsed.hex },
        );
      }
      return Object.freeze({
        key: parsed,
        sizeBytes: info.size,
        location: this.location(parsed),
      });
    } catch (error) {
      if (sysCode(error) === "ENOENT") {
        return null;
      }
      throw fsFailure(error, "UNSAFE_FILESYSTEM_STATE", "The object could not be inspected.");
    }
  }

  async verify(key: ContentKey): Promise<void> {
    const stream = await this.openRead(key, { verify: true });
    for await (const chunk of stream) {
      void chunk;
    }
  }

  async delete(key: ContentKey): Promise<boolean> {
    const parsed = parseContentKey(key);
    this.#assertOpen();
    const objectPath = this.#objectPath(parsed);
    try {
      await unlink(objectPath);
      return true;
    } catch (error) {
      if (sysCode(error) === "ENOENT") {
        return false;
      }
      throw fsFailure(error, "UNSAFE_FILESYSTEM_STATE", "The object could not be deleted.");
    }
  }

  // -- temp cleanup ---------------------------------------------------------

  cleanupTemporaryFiles(options: TempCleanupOptions): Promise<TempCleanupReport> {
    return this.#track(async () => {
      const olderThanMs = ensureSafeSizeOption(options?.olderThanMs, "olderThanMs", 0);
      const cutoff = this.#clock.now().valueOf() - olderThanMs;
      let entries;
      try {
        entries = await readdir(this.#tempDir, { withFileTypes: true });
      } catch (error) {
        throw fsFailure(error, "CLEANUP_FAILED", "The temporary directory could not be listed.");
      }

      let removedCount = 0;
      let retainedCount = 0;
      let failedCount = 0;
      for (const entry of entries) {
        // Only regular files matching the store's own strict temp format
        // are ever eligible; everything else is left untouched.
        if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) {
          retainedCount += 1;
          continue;
        }
        const filePath = join(this.#tempDir, entry.name);
        try {
          const info = await stat(filePath);
          if (info.mtimeMs <= cutoff) {
            await unlink(filePath);
            removedCount += 1;
          } else {
            retainedCount += 1;
          }
        } catch (error) {
          if (sysCode(error) === "ENOENT") {
            removedCount += 1;
            continue;
          }
          failedCount += 1;
        }
      }
      return Object.freeze({ removedCount, retainedCount, failedCount });
    });
  }
}
