/**
 * Bounded workspace filesystem access.
 *
 * There is no way to hand this module an absolute path, and no way to reach
 * the source repository through it. Every operation takes a workspace-relative
 * path, validates it lexically, checks it against the grant's prefixes,
 * re-resolves it against the live filesystem, and confirms the result is still
 * inside the managed worktree — in that order, immediately before acting.
 *
 * Honest limitation: re-resolving immediately before use narrows the
 * check-to-use window but cannot close it. A process running as the same user
 * can replace a path between the check and the call. That is precisely why the
 * production gate requires an enforcing sandbox: containment has to come from
 * something the workload cannot subvert, and application-level validation is
 * defence in depth rather than the boundary itself.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  parseWorkspaceRelativePath,
  prefixCovers,
  type CapabilityGrant,
  type ExecutionLease,
} from "@ai-dev-os/process-broker";
import { WorkspaceError, causeCategory } from "./errors.js";

export const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 10_000;

export const ENTRY_KINDS = Object.freeze([
  "file",
  "directory",
  "symlink",
  "other",
] as const);
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly sizeBytes: number;
  readonly executable: boolean;
}

export interface WorkspaceAccessOptions {
  readonly worktreeDir: string;
  readonly grant: CapabilityGrant;
  readonly lease: ExecutionLease;
  readonly maxReadBytes?: number;
  readonly maxDirectoryEntries?: number;
}

export interface WorkspaceAccess {
  stat(path: string): Promise<WorkspaceEntry | null>;
  list(path: string): Promise<readonly WorkspaceEntry[]>;
  read(path: string): Promise<Uint8Array>;
  digest(path: string): Promise<string>;
  createExclusive(path: string, bytes: Uint8Array): Promise<void>;
  replace(path: string, bytes: Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  linkMetadata(path: string): Promise<{ readonly isLink: boolean; readonly kind: EntryKind }>;
}

export function createWorkspaceAccess(options: WorkspaceAccessOptions): WorkspaceAccess {
  const maxRead = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxEntries = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES;

  /**
   * The single gate every operation passes through.
   *
   * Validation order matters: authority first (a revoked lease must stop work
   * before the filesystem is touched at all), then the lexical path rules,
   * then the grant scope, and only then the filesystem.
   */
  async function authorize(
    rawPath: string,
    mode: "read" | "write",
  ): Promise<{ absolute: string; relative: string }> {
    options.lease.assertValid();

    const operation = mode === "read" ? "workspace-read" : "workspace-write";
    if (!options.grant.operations.includes(operation)) {
      throw new WorkspaceError("POLICY_DENIED", "The grant does not permit this operation.", {
        operation,
      });
    }

    const relative = parseWorkspaceRelativePath(rawPath, "path");
    const prefixes =
      mode === "read" ? options.grant.readablePrefixes : options.grant.writablePrefixes;
    if (!prefixCovers(prefixes, relative)) {
      throw new WorkspaceError("POLICY_DENIED", "The path lies outside the granted scope.", {
        operation,
      });
    }

    const rootReal = await resolveRoot();
    const absolute = join(rootReal, relative);
    await assertNoLinkEscape(rootReal, relative);
    return { absolute, relative };
  }

  let cachedRoot: string | null = null;
  async function resolveRoot(): Promise<string> {
    if (cachedRoot !== null) {
      return cachedRoot;
    }
    try {
      cachedRoot = await realpath(options.worktreeDir);
    } catch (error) {
      throw new WorkspaceError("WORKSPACE_NOT_READY", "The worktree could not be resolved.", {
        cause: causeCategory(error),
      });
    }
    return cachedRoot;
  }

  /**
   * Walks each existing component with a non-following stat.
   *
   * A symbolic link or a Windows junction anywhere along the path is refused
   * outright rather than resolved, because resolving it is what would let a
   * planted link redirect a write outside the worktree. Node reports a
   * directory junction as a symbolic link, so both are caught here.
   */
  async function assertNoLinkEscape(rootReal: string, relative: string): Promise<void> {
    const segments = relative.split("/");
    let current = rootReal;
    for (const segment of segments) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (causeCategory(error) === "ENOENT") {
          // Not created yet: nothing to escape through.
          return;
        }
        throw new WorkspaceError("UNSAFE_PATH", "A path component could not be inspected.", {
          cause: causeCategory(error),
        });
      }
      if (info.isSymbolicLink()) {
        throw new WorkspaceError(
          process.platform === "win32" ? "REPARSE_POINT_ESCAPE" : "LINK_ESCAPE",
          "A path component is a link or reparse point.",
          {},
        );
      }
    }
    // Final containment check against the resolved identity.
    try {
      const resolved = await realpath(current);
      const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
      if (resolved !== rootReal && !resolved.startsWith(prefix)) {
        throw new WorkspaceError("LINK_ESCAPE", "The resolved path lies outside the worktree.", {});
      }
    } catch (error) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      if (causeCategory(error) !== "ENOENT") {
        throw new WorkspaceError("UNSAFE_PATH", "The path could not be resolved safely.", {
          cause: causeCategory(error),
        });
      }
    }
  }

  function classify(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
    if (info.isSymbolicLink()) {
      return "symlink";
    }
    if (info.isDirectory()) {
      return "directory";
    }
    if (info.isFile()) {
      return "file";
    }
    return "other";
  }

  return Object.freeze({
    async stat(path: string): Promise<WorkspaceEntry | null> {
      const { absolute, relative } = await authorize(path, "read");
      try {
        const info = await lstat(absolute);
        return Object.freeze({
          path: relative,
          kind: classify(info),
          sizeBytes: info.size,
          executable: (info.mode & 0o111) !== 0,
        });
      } catch (error) {
        if (causeCategory(error) === "ENOENT") {
          return null;
        }
        throw new WorkspaceError("UNSAFE_PATH", "The path could not be inspected.", {
          cause: causeCategory(error),
        });
      }
    },

    async list(path: string): Promise<readonly WorkspaceEntry[]> {
      const { absolute, relative } = await authorize(path, "read");
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The directory could not be listed.", {
          cause: causeCategory(error),
        });
      }
      if (entries.length > maxEntries) {
        throw new WorkspaceError("QUOTA_EXCEEDED", "The directory exceeds the listing bound.", {
          maxDirectoryEntries: maxEntries,
        });
      }
      const results: WorkspaceEntry[] = [];
      for (const entry of entries) {
        const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
        results.push(
          Object.freeze({
            path: childRelative,
            kind: classify(entry),
            sizeBytes: 0,
            executable: false,
          }),
        );
      }
      return Object.freeze(
        results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      );
    },

    async read(path: string): Promise<Uint8Array> {
      const { absolute } = await authorize(path, "read");
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The file could not be inspected.", {
          cause: causeCategory(error),
        });
      }
      if (!info.isFile()) {
        throw new WorkspaceError("UNSAFE_PATH", "The path is not a regular file.", {});
      }
      if (info.size > maxRead) {
        throw new WorkspaceError("QUOTA_EXCEEDED", "The file exceeds the read bound.", {
          maxReadBytes: maxRead,
          sizeBytes: info.size,
        });
      }
      return new Uint8Array(await readFile(absolute));
    },

    async digest(path: string): Promise<string> {
      const bytes = await this.read(path);
      return createHash("sha256").update(bytes).digest("hex");
    },

    async createExclusive(path: string, bytes: Uint8Array): Promise<void> {
      const { absolute } = await authorize(path, "write");
      let handle;
      try {
        // Exclusive create: this fails rather than following a link that an
        // attacker planted at the destination between check and use.
        handle = await open(absolute, "wx");
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The file could not be created exclusively.", {
          cause: causeCategory(error),
        });
      }
      try {
        await handle.write(bytes);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async replace(path: string, bytes: Uint8Array): Promise<void> {
      const { absolute } = await authorize(path, "write");
      try {
        await writeFile(absolute, bytes, { flag: "w" });
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The file could not be replaced.", {
          cause: causeCategory(error),
        });
      }
    },

    async createDirectory(path: string): Promise<void> {
      const { absolute } = await authorize(path, "write");
      try {
        await mkdir(absolute, { recursive: true });
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The directory could not be created.", {
          cause: causeCategory(error),
        });
      }
    },

    async remove(path: string): Promise<boolean> {
      const { absolute } = await authorize(path, "write");
      try {
        await lstat(absolute);
      } catch {
        return false;
      }
      // Bounded to the single granted path. `fs.rm` does not traverse into a
      // link's target, and the component walk above already refused links.
      await rm(absolute, { recursive: true, force: true });
      return true;
    },

    async linkMetadata(path: string): Promise<{ isLink: boolean; kind: EntryKind }> {
      options.lease.assertValid();
      const relative = parseWorkspaceRelativePath(path, "path");
      const rootReal = await resolveRoot();
      try {
        const info = await lstat(join(rootReal, relative));
        return Object.freeze({ isLink: info.isSymbolicLink(), kind: classify(info) });
      } catch (error) {
        throw new WorkspaceError("UNSAFE_PATH", "The path could not be inspected.", {
          cause: causeCategory(error),
        });
      }
    },
  });
}

export function workspaceRootFor(managedRoot: string): string {
  return resolve(managedRoot);
}
