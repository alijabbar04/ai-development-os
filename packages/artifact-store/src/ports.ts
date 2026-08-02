import type { ArtifactId } from "@ai-dev-os/domain";
import type { ContentKey, DigestAlgorithm } from "./content-key.js";
import type { ByteStream } from "./streams.js";

/** Injectable time source. Adapters must never read the system clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

/** Current physical layout version of content-addressed storage. */
export const STORE_LAYOUT_VERSION = 1 as const;

/**
 * Where an object lives, expressed as a layout version plus a
 * forward-slash relative path inside the store root. Absolute filesystem
 * paths never cross the port boundary.
 */
export interface ContentLocation {
  readonly layoutVersion: typeof STORE_LAYOUT_VERSION;
  readonly relativePath: string;
}

export interface WriteOptions {
  /** Digest algorithm for content addressing. Default "sha-256". */
  readonly algorithm?: DigestAlgorithm;
  /**
   * Expected content key. When provided, its algorithm is used and a
   * mismatch fails with DIGEST_MISMATCH after streaming completes.
   */
  readonly expectedKey?: ContentKey;
  /** Exact byte count the stream must produce, else SIZE_MISMATCH. */
  readonly expectedSizeBytes?: number;
  /** Hard cap enforced while streaming, else SIZE_LIMIT_EXCEEDED. */
  readonly maxSizeBytes?: number;
  /**
   * Optional caller correlation: the artifact descriptor id this content
   * belongs to. Echoed in the result; never used in physical paths.
   */
  readonly artifactId?: ArtifactId | string | null;
}

export interface WriteResult {
  readonly key: ContentKey;
  readonly sizeBytes: number;
  readonly location: ContentLocation;
  /** True when identical content already existed and was reused. */
  readonly deduplicated: boolean;
  readonly artifactId: string | null;
}

export interface ObjectStat {
  readonly key: ContentKey;
  readonly sizeBytes: number;
  readonly location: ContentLocation;
}

export interface ReadOptions {
  /**
   * Verify content while streaming. Corruption (digest or size mismatch)
   * is reported at stream COMPLETION — bytes already yielded must be
   * discarded by the caller when the stream throws OBJECT_CORRUPTED.
   */
  readonly verify?: boolean;
}

export interface ReadBytesOptions extends ReadOptions {
  /** Upper bound for buffering. Default DEFAULT_READ_BYTES_LIMIT. */
  readonly maxBytes?: number;
}

export const DEFAULT_READ_BYTES_LIMIT = 16_777_216;
export const DEFAULT_MAX_WRITE_BYTES = 1_073_741_824;

export interface TempCleanupOptions {
  /** Temp files whose age (per the injected clock) is at least this are removed. */
  readonly olderThanMs: number;
}

export interface TempCleanupReport {
  readonly removedCount: number;
  readonly retainedCount: number;
  readonly failedCount: number;
}

/**
 * Content-addressed byte storage. Stores and serves verified bytes only;
 * artifact descriptors, manifests, classifications, reference counting,
 * and retention decisions live in the persistence/metadata layer.
 *
 * Coordinating a byte write with a descriptor write is the caller's job
 * and is NOT a distributed atomic transaction: write bytes first, then
 * persist the descriptor referencing the returned key; on descriptor
 * failure the orphaned bytes are reclaimed by a later retention service.
 */
export interface ArtifactByteStore {
  /** Streams content into the store; see the write-protocol documentation. */
  write(source: ByteStream, options?: WriteOptions): Promise<WriteResult>;
  /** Bounded convenience over write() for content already in memory. */
  writeBytes(value: Uint8Array | string, options?: WriteOptions): Promise<WriteResult>;
  /**
   * Opens a byte stream for an object. Missing objects fail here with
   * OBJECT_NOT_FOUND; with `verify`, corruption fails at stream completion.
   */
  openRead(key: ContentKey, options?: ReadOptions): Promise<ByteStream>;
  /** Bounded convenience over openRead(). */
  readBytes(key: ContentKey, options?: ReadBytesOptions): Promise<Uint8Array>;
  exists(key: ContentKey): Promise<boolean>;
  stat(key: ContentKey): Promise<ObjectStat | null>;
  /** Full integrity check: reads every byte and verifies digest and size. */
  verify(key: ContentKey): Promise<void>;
  /**
   * Deletes an object by validated content key. Returns false when the
   * object was already absent (idempotent). Whether content is still
   * referenced is a metadata/retention decision this store cannot make.
   */
  delete(key: ContentKey): Promise<boolean>;
  /** Deterministic location for a key; pure, no I/O. */
  location(key: ContentKey): ContentLocation;
  /** Removes stale temp files matching the store's own strict format. */
  cleanupTemporaryFiles(options: TempCleanupOptions): Promise<TempCleanupReport>;
  /**
   * Waits for in-flight writes, aborts open read streams, releases
   * resources. Idempotent; later operations fail with STORE_CLOSED.
   */
  close(): Promise<void>;
}
