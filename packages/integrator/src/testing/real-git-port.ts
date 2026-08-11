import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeTrimmed,
  discoverRepository,
  splitNulRecords,
  type GitRuntime,
  type RepositoryDiscovery,
} from "@ai-dev-os/workspace";
import {
  INTEGRATION_SCHEMA_VERSION,
  type IntegrationCleanupResult,
  type IntegrationConflict,
  type IntegrationEffectIntent,
  type IntegrationGitPort,
  type IntegrationPreflightResult,
  type IntegrationReceipt,
  type IntegrationRecoveryState,
  type IntegrationRequest,
} from "../contracts.js";
import { IntegrationError } from "../errors.js";
import {
  compareIntegrationText,
  integrationDigest,
  parseIntegrationPreflightResult,
  parseIntegrationReceipt,
  parseIntegrationRecoveryState,
  stableIntegrationId,
} from "../schema.js";

export const REAL_GIT_FAILURE_BOUNDARIES = Object.freeze([
  "before-preflight",
  "after-worktree-register",
  "after-worktree-create",
  "before-index-update",
  "after-index-update",
  "before-write-tree",
  "after-write-tree",
  "after-commit-create",
  "before-ref-update",
  "after-ref-update",
  "before-receipt",
  "cleanup",
] as const);
export type RealGitFailureBoundary = (typeof REAL_GIT_FAILURE_BOUNDARIES)[number];

export interface RealGitIntegrationPortOptions {
  readonly runtime: GitRuntime;
  /** Exact task-owned repository. Never point this at a product repository. */
  readonly repositoryRoot: string;
  /** Exact task-owned parent containing both repository and integration worktrees. */
  readonly fixtureRoot: string;
  readonly workspaceRoot: string;
  /** Exact local refs that this fixture route may never update. */
  readonly protectedRefs: readonly string[];
  readonly now: () => string;
  readonly failAt?: RealGitFailureBoundary;
  readonly onBoundary?: (boundary: RealGitFailureBoundary) => void | Promise<void>;
}

interface CanonicalRealGitRoute {
  readonly repositoryRoot: string;
  readonly fixtureRoot: string;
  readonly workspaceRoot: string;
  readonly protectedRefs: readonly string[];
}

type CapturedRealGitIntegrationPortOptions = RealGitIntegrationPortOptions & {
  readonly capturedRouteFingerprint: string;
  readonly capturedTargetFingerprint: string;
};

function finiteRouteInspection<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("INVALID_INPUT", "Real Git route inspection failed at a finite boundary.");
  }
}

async function finitePortOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", `Real Git ${operation} failed at a finite redacted boundary.`);
  }
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new IntegrationError("INVALID_INPUT", "Real Git route paths must be absolute.");
  const resolved = resolve(path);
  let current = resolved;
  for (;;) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new IntegrationError("INVALID_INPUT", "Real Git route paths cannot contain links.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const info = lstatSync(resolved);
  if (!info.isDirectory()) throw new IntegrationError("INVALID_INPUT", "Real Git route paths must be directories.");
  return realpathSync.native(resolved);
}

function canonicalRealGitRoute(
  options: Pick<RealGitIntegrationPortOptions, "repositoryRoot" | "fixtureRoot" | "workspaceRoot" | "protectedRefs">,
): CanonicalRealGitRoute {
  const protectedRefs = Object.freeze([...options.protectedRefs].sort(compareIntegrationText));
  if (protectedRefs.length === 0 || new Set(protectedRefs.map((ref) => ref.toLowerCase())).size !== protectedRefs.length || protectedRefs.some((ref) => !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,191}$/u.test(ref))) {
    throw new IntegrationError("INVALID_INPUT", "Real Git protected refs must be a nonempty unique local-ref set.");
  }
  const fixtureRoot = canonicalDirectory(options.fixtureRoot);
  const repositoryRoot = canonicalDirectory(options.repositoryRoot);
  const workspaceRoot = canonicalDirectory(options.workspaceRoot);
  if (!within(fixtureRoot, repositoryRoot) || !within(fixtureRoot, workspaceRoot) || repositoryRoot === fixtureRoot || workspaceRoot === fixtureRoot || within(repositoryRoot, workspaceRoot) || within(workspaceRoot, repositoryRoot)) {
    throw new IntegrationError("INVALID_INPUT", "Real Git fixture paths escape the exact task-owned root.");
  }
  return Object.freeze({
    repositoryRoot,
    fixtureRoot,
    workspaceRoot,
    protectedRefs,
  });
}

function readCanonicalGitPath(path: string, prefix: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4_096) {
    throw new IntegrationError("LIMIT_EXCEEDED", "Git administrative path metadata exceeds its exact finite bound.");
  }
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new IntegrationError("INVALID_INPUT", "Git administrative path metadata is not canonical UTF-8.");
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.length <= prefix.length || !line.startsWith(prefix) || /[\u0000-\u001f\u007f]/u.test(line)) {
    throw new IntegrationError("INVALID_INPUT", "Git administrative path metadata is malformed.");
  }
  return line.slice(prefix.length);
}

function assertClosedObjectDatabase(commonGitDirectory: string): void {
  for (const relativePath of ["objects/info/alternates", "info/grafts", "shallow", "refs/replace"]) {
    const candidate = join(commonGitDirectory, ...relativePath.split("/"));
    if (existsSync(candidate)) {
      throw new IntegrationError("UNAUTHORIZED", "Repository object identity depends on unsupported alternate, graft, shallow, or replace metadata.");
    }
  }
  if (existsSync(join(commonGitDirectory, "info", "attributes"))) {
    throw new IntegrationError("UNAUTHORIZED", "Repository-local info attributes are outside the reviewed tree-bound attribute contract.");
  }
  const packedRefs = join(commonGitDirectory, "packed-refs");
  if (!existsSync(packedRefs)) return;
  const info = lstatSync(packedRefs);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) {
    throw new IntegrationError("LIMIT_EXCEEDED", "Packed Git reference metadata exceeds the reviewed exactness bound.");
  }
  const bytes = readFileSync(packedRefs);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new IntegrationError("INVALID_INPUT", "Packed Git reference metadata is not canonical UTF-8.");
  if (/(?:^|\n)[a-f0-9]+ refs\/replace\//u.test(text)) {
    throw new IntegrationError("UNAUTHORIZED", "Repository replace refs are outside the exact immutable-object contract.");
  }
}

function assertClosedGitConfiguration(gitDirectory: string, commonGitDirectory: string): void {
  const files = new Set([join(commonGitDirectory, "config"), join(gitDirectory, "config.worktree")]);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new IntegrationError("LIMIT_EXCEEDED", "Repository-local Git configuration exceeds its exact finite bound.");
    }
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) {
      throw new IntegrationError("INVALID_INPUT", "Repository-local Git configuration is not canonical UTF-8 text.");
    }
    if (/^\s*\[\s*include(?:if\b|\s*\])/imu.test(text) || /^\s*(?:attributesfile|excludesfile|orderfile|ignorerevsfile)\s*=/imu.test(text)) {
      throw new IntegrationError("UNAUTHORIZED", "Repository-local Git configuration references external or conditional configuration state.");
    }
    let section = "";
    const enablesTransportOrLazyFetch = text.split(/\r?\n/u).some((line) => {
      const sectionMatch = /^\s*\[\s*([A-Za-z0-9.-]+)/u.exec(line);
      if (sectionMatch?.[1] !== undefined) {
        section = sectionMatch[1].toLowerCase();
        return false;
      }
      const key = /^\s*([A-Za-z0-9.-]+)\s*=/u.exec(line)?.[1]?.toLowerCase();
      if (key === undefined) return false;
      return section === "protocol" && key === "allow" || section === "extensions" && key === "partialclone" ||
        section === "remote" && ["promisor", "partialclonefilter"].includes(key) ||
        /^protocol\..+\.allow$/u.test(key) || key === "extensions.partialclone" || /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key);
    });
    if (enablesTransportOrLazyFetch) {
      throw new IntegrationError("UNAUTHORIZED", "Repository-local Git configuration enables transport or lazy object fetching outside the reviewed boundary.");
    }
  }
}

function assertContainedGitAdministration(fixtureRoot: string, gitDirectory: string, commonGitDirectory: string): void {
  const roots = new Set([
    join(commonGitDirectory, "objects"),
    join(commonGitDirectory, "refs"),
    join(commonGitDirectory, "logs"),
    join(commonGitDirectory, "info"),
    join(commonGitDirectory, "worktrees"),
    join(commonGitDirectory, "config"),
    join(commonGitDirectory, "packed-refs"),
    join(gitDirectory, "HEAD"),
    join(gitDirectory, "index"),
    join(gitDirectory, "config.worktree"),
    join(gitDirectory, "commondir"),
  ]);
  const stack = [...roots].filter((item) => existsSync(item));
  let inspected = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    inspected += 1;
    if (inspected > 100_000) throw new IntegrationError("LIMIT_EXCEEDED", "Git administrative containment inspection exceeded its finite entry bound.");
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new IntegrationError("UNAUTHORIZED", "Git administrative storage contains a linked or reparse-point escape.");
    const canonical = realpathSync.native(current);
    if (!within(fixtureRoot, canonical)) throw new IntegrationError("UNAUTHORIZED", "Git administrative storage resolves outside the task-owned fixture.");
    if (!info.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) stack.push(join(current, entry.name));
  }
}

function containedCanonicalDirectory(fixtureRoot: string, candidate: string): string {
  const resolved = resolve(candidate);
  if (!within(fixtureRoot, resolved)) throw new IntegrationError("UNAUTHORIZED", "Git administrative storage escapes the exact task-owned fixture root.");
  const canonical = canonicalDirectory(resolved);
  if (!within(fixtureRoot, canonical)) throw new IntegrationError("UNAUTHORIZED", "Git administrative storage resolves outside the exact task-owned fixture root.");
  return canonical;
}

function canonicalCommonGitDirectory(repositoryRoot: string, fixtureRoot: string): string {
  const repository = canonicalDirectory(repositoryRoot);
  const fixture = canonicalDirectory(fixtureRoot);
  if (!within(fixture, repository)) throw new IntegrationError("UNAUTHORIZED", "Repository route escapes the exact task-owned fixture root.");
  const dotGit = join(repository, ".git");
  const dotGitInfo = lstatSync(dotGit);
  let gitDirectory: string;
  if (dotGitInfo.isDirectory() && !dotGitInfo.isSymbolicLink()) gitDirectory = containedCanonicalDirectory(fixture, dotGit);
  else if (dotGitInfo.isFile() && !dotGitInfo.isSymbolicLink()) gitDirectory = containedCanonicalDirectory(fixture, resolve(repository, readCanonicalGitPath(dotGit, "gitdir: ")));
  else throw new IntegrationError("INVALID_INPUT", "Repository Git administration is not an exact directory or indirection file.");
  const commonFile = join(gitDirectory, "commondir");
  if (!existsSync(commonFile)) {
    assertClosedObjectDatabase(gitDirectory);
    assertClosedGitConfiguration(gitDirectory, gitDirectory);
    assertContainedGitAdministration(fixture, gitDirectory, gitDirectory);
    return gitDirectory;
  }
  const commonInfo = lstatSync(commonFile);
  if (!commonInfo.isFile() || commonInfo.isSymbolicLink()) throw new IntegrationError("INVALID_INPUT", "Git common-directory metadata is malformed.");
  const commonDirectory = containedCanonicalDirectory(fixture, resolve(gitDirectory, readCanonicalGitPath(commonFile, "")));
  assertClosedObjectDatabase(commonDirectory);
  assertClosedGitConfiguration(gitDirectory, commonDirectory);
  assertContainedGitAdministration(fixture, gitDirectory, commonDirectory);
  return commonDirectory;
}

export function realGitIntegrationTargetFingerprint(options: Pick<RealGitIntegrationPortOptions, "repositoryRoot" | "fixtureRoot">): string {
  return finiteRouteInspection(() => integrationDigest({
      portId: "integration-git:real-disposable-fixture",
      schemaVersion: 1,
      commonGitDirectory: canonicalCommonGitDirectory(options.repositoryRoot, options.fixtureRoot),
    }));
}

export function realGitIntegrationRouteFingerprint(
  options: Pick<RealGitIntegrationPortOptions, "repositoryRoot" | "fixtureRoot" | "workspaceRoot" | "protectedRefs">,
): string {
  return finiteRouteInspection(() => {
    const canonical = canonicalRealGitRoute(options);
    return integrationDigest({
      portId: "integration-git:real-disposable-fixture",
      schemaVersion: 1,
      ...canonical,
    });
  });
}

interface GitContext {
  readonly discovery: RepositoryDiscovery;
  readonly config: readonly string[];
  readonly signal: AbortSignal;
}

function exactUtf8(buffer: Buffer): void {
  const decoded = buffer.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(buffer)) throw new IntegrationError("CONFLICT", "Git returned a repository name that is not canonical UTF-8.");
}

function exactNulRecords(buffer: Buffer): readonly string[] {
  exactUtf8(buffer);
  return splitNulRecords(buffer);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertTaskOwned(options: RealGitIntegrationPortOptions): Promise<void> {
  if (![options.repositoryRoot, options.fixtureRoot, options.workspaceRoot].every((item) => typeof item === "string" && isAbsolute(item))) {
    throw new IntegrationError("INVALID_INPUT", "Real Git fixture roots must be absolute.");
  }
  const currentRouteFingerprint = realGitIntegrationRouteFingerprint(options);
  const capturedRouteFingerprint = (options as Partial<CapturedRealGitIntegrationPortOptions>).capturedRouteFingerprint;
  if (capturedRouteFingerprint !== undefined && currentRouteFingerprint !== capturedRouteFingerprint) {
    throw new IntegrationError("UNAUTHORIZED", "Real Git route identity changed after port construction.");
  }
  const capturedTargetFingerprint = (options as Partial<CapturedRealGitIntegrationPortOptions>).capturedTargetFingerprint;
  if (capturedTargetFingerprint !== undefined && realGitIntegrationTargetFingerprint(options) !== capturedTargetFingerprint) {
    throw new IntegrationError("UNAUTHORIZED", "Real Git physical repository identity changed after port construction.");
  }
  const fixture = await realpath(options.fixtureRoot);
  const repository = await realpath(options.repositoryRoot);
  const workspaceParent = await realpath(options.workspaceRoot).catch(() => resolve(options.workspaceRoot));
  if (!within(fixture, repository) || !within(fixture, workspaceParent) || repository === fixture || workspaceParent === fixture || within(repository, workspaceParent) || within(workspaceParent, repository)) {
    throw new IntegrationError("INVALID_INPUT", "Real Git fixture paths escape the exact task-owned root.");
  }
  for (const target of [fixture, repository]) {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new IntegrationError("INVALID_INPUT", "Real Git fixture root cannot be a link or non-directory.");
  }
}

async function boundary(options: RealGitIntegrationPortOptions, name: RealGitFailureBoundary, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git fixture operation was aborted.");
  await options.onBoundary?.(name);
  if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git fixture operation was aborted.");
  if (options.failAt === name) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Injected Git fixture boundary failed.", { boundary: name });
}

function baseArgs(context: GitContext): readonly string[] {
  return Object.freeze([...context.config, ...context.discovery.programConfigOverrides, "-C", context.discovery.root]);
}

async function run(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  args: readonly string[],
  toleratedExitCodes: readonly number[] = [0],
  environment?: ReturnType<GitRuntime["environment"]>,
  stdin?: Uint8Array,
): Promise<{ readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }> {
  try {
    const result = await options.runtime.runner.run([...baseArgs(context), ...args], {
      cwd: options.fixtureRoot,
      env: environment ?? options.runtime.environment(),
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024 * 1024,
      toleratedExitCodes,
      signal: context.signal,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (!toleratedExitCodes.includes(result.exitCode)) {
      const operation = typeof args[0] === "string" && /^[a-z-]+$/u.test(args[0]) ? args[0] : "git";
      throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Reviewed Git fixture command returned a non-success status.", { exitCode: result.exitCode, operation });
    }
    return result;
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Reviewed Git fixture operation failed.", { failureKind: error instanceof Error ? "error" : "non-error" });
  }
}

function effectGuardRef(request: IntegrationRequest): string {
  const digest = request.requestDigest;
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new IntegrationError("INVALID_INPUT", "Integration intent cannot derive an exact Git-side fence.");
  return `refs/ai-dev-os/integration-guards/${digest}`;
}

async function assertEffectGuardAbsent(options: RealGitIntegrationPortOptions, context: GitContext, request: IntegrationRequest): Promise<void> {
  const guardRef = effectGuardRef(request);
  const symbolic = await run(options, context, ["symbolic-ref", "--quiet", guardRef], [0, 1]);
  if (symbolic.exitCode === 0) throw new IntegrationError("CONFLICT", "Git-side integration fence is already occupied.");
  const existing = await run(options, context, ["show-ref", "--verify", "--hash", guardRef], [0, 1, 128]);
  if (existing.exitCode === 0) throw new IntegrationError("CONFLICT", "Git-side integration fence is already occupied.");
}

async function armEffectGuard(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  intent: IntegrationEffectIntent,
  request: IntegrationRequest,
): Promise<void> {
  const zero = "0".repeat(request.repository.objectFormat === "sha1" ? 40 : 64);
  await run(options, context, ["update-ref", "--no-deref", effectGuardRef(request), request.repository.sourceCommit, zero]);
}

async function publishWithEffectGuard(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  intent: IntegrationEffectIntent,
  request: IntegrationRequest,
  integratedCommit: string,
): Promise<void> {
  const commands = Buffer.from([
    "start",
    "option no-deref",
    `update ${request.repository.targetRef} ${integratedCommit} ${request.repository.expectedTargetCommit}`,
    `delete ${effectGuardRef(request)} ${request.repository.sourceCommit}`,
    "prepare",
    "commit",
    "",
  ].join("\n"), "utf8");
  await run(options, context, ["update-ref", "--stdin"], [0], undefined, commands);
}

async function revokeEffectGuard(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  intent: IntegrationEffectIntent,
  request: IntegrationRequest,
): Promise<"revoked" | "absent"> {
  const guardRef = effectGuardRef(request);
  const symbolic = await run(options, context, ["symbolic-ref", "--quiet", guardRef], [0, 1]);
  if (symbolic.exitCode === 0) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git-side integration fence was replaced by a symbolic ref.");
  }
  const existing = await run(options, context, ["show-ref", "--verify", "--hash", guardRef], [0, 1, 128]);
  if (existing.exitCode !== 0) return "absent";
  exactUtf8(existing.stdout);
  if (decodeTrimmed(existing.stdout) !== request.repository.sourceCommit) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git-side integration fence no longer has the exact armed value.");
  const deletion = await run(options, context, ["update-ref", "--no-deref", "-d", guardRef, request.repository.sourceCommit], [0, 1, 128]);
  if (deletion.exitCode === 0) return "revoked";
  const remaining = await run(options, context, ["show-ref", "--verify", "--hash", guardRef], [0, 1, 128]);
  if (remaining.exitCode !== 0) return "absent";
  throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git-side integration fence could not be revoked exactly.");
}

async function contextFor(options: RealGitIntegrationPortOptions, signal: AbortSignal): Promise<GitContext> {
  await assertTaskOwned(options);
  const runtime = Object.freeze({
    ...options.runtime,
    runner: Object.freeze({
      run: (args: readonly string[], runOptions: Parameters<GitRuntime["runner"]["run"]>[1]) =>
        options.runtime.runner.run(args, { ...runOptions, signal }),
    }),
  });
  const discovery = await discoverRepository(runtime, {
    directory: options.repositoryRoot,
    allowedRoots: [options.fixtureRoot],
    maxUntrackedPaths: 10_000,
    timeoutMs: 120_000,
  });
  for (const adminPath of [discovery.gitDir, discovery.commonGitDir]) {
    const canonicalAdmin = await realpath(adminPath);
    const info = await lstat(canonicalAdmin);
    if (!info.isDirectory() || !within(options.fixtureRoot, canonicalAdmin)) {
      throw new IntegrationError("UNAUTHORIZED", "Real Git administrative storage escapes the exact task-owned fixture root.");
    }
  }
  assertClosedGitConfiguration(discovery.gitDir, discovery.commonGitDir);
  return Object.freeze({ discovery, config: Object.freeze([...options.runtime.configArguments(), ...discovery.programConfigOverrides]), signal });
}

async function assertNoUntrackedPaths(options: RealGitIntegrationPortOptions, context: GitContext): Promise<void> {
  const result = await run(options, context, ["ls-files", "--others", "-z", "--"]);
  const paths = exactNulRecords(result.stdout);
  if (paths.length > 0) throw new IntegrationError("TARGET_DRIFT", "Repository contains untracked or ignored-untracked paths.");
}

async function revision(options: RealGitIntegrationPortOptions, context: GitContext, expression: string): Promise<string | null> {
  const result = await run(options, context, ["rev-parse", "--verify", "--quiet", expression], [0, 1]);
  return result.exitCode === 0 ? decodeTrimmed(result.stdout) : null;
}

async function assertWritableTarget(options: RealGitIntegrationPortOptions, context: GitContext, targetRef: string): Promise<void> {
  if (options.protectedRefs.some((protectedRef) => protectedRef.toLowerCase() === targetRef.toLowerCase())) {
    throw new IntegrationError("UNAUTHORIZED", "The integration fixture cannot update a configured protected ref.");
  }
  const symbolic = await run(options, context, ["symbolic-ref", "--quiet", targetRef], [0, 1]);
  if (symbolic.exitCode === 0) {
    throw new IntegrationError("UNAUTHORIZED", "The integration fixture cannot update a symbolic target ref.");
  }
  const checkedOut = await run(options, context, ["for-each-ref", "--format=%(worktreepath)", targetRef]);
  exactUtf8(checkedOut.stdout);
  if (decodeTrimmed(checkedOut.stdout).length > 0) {
    throw new IntegrationError("UNAUTHORIZED", "The integration fixture cannot update a branch checked out in any worktree.");
  }
}

async function registeredWorktreePaths(options: RealGitIntegrationPortOptions, context: GitContext): Promise<readonly string[]> {
  const result = await run(options, context, ["worktree", "list", "--porcelain", "-z"]);
  const records = exactNulRecords(result.stdout);
  return Object.freeze(records
    .filter((record) => record.startsWith("worktree "))
    .map((record) => record.slice("worktree ".length)));
}

async function isRegisteredWorktree(options: RealGitIntegrationPortOptions, context: GitContext, path: string): Promise<boolean> {
  return (await registeredWorktreePaths(options, context)).some((candidate) => sameFilesystemPath(candidate, path));
}

function worktreeOwnerClaimPath(options: RealGitIntegrationPortOptions, worktreeId: string): string {
  return join(resolve(options.workspaceRoot), `.ai-dev-os-integration-claim-${worktreeId.slice("integration-worktree:".length)}`);
}

async function hasExactWorktreeOwnerClaim(options: RealGitIntegrationPortOptions, worktreeId: string): Promise<boolean> {
  const claimPath = worktreeOwnerClaimPath(options, worktreeId);
  const info = await lstat(claimPath).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isFile()) return false;
  return await readFile(claimPath, "utf8").catch(() => null) === `${worktreeId}\n`;
}

async function isExactRegisteredWorktree(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  path: string,
): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink() || !await isRegisteredWorktree(options, context, path)) return false;
  try {
    const canonicalPath = await realpath(path);
    return within(options.workspaceRoot, canonicalPath) && sameFilesystemPath(
      canonicalCommonGitDirectory(canonicalPath, options.fixtureRoot),
      canonicalCommonGitDirectory(options.repositoryRoot, options.fixtureRoot),
    );
  } catch {
    return false;
  }
}

async function isExactPreservedWorktree(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  path: string,
  worktreeId: string,
): Promise<boolean> {
  if (!await isExactRegisteredWorktree(options, context, path)) return false;
  try {
    const canonicalPath = await realpath(path);
    const marker = await readFile(join(canonicalPath, ".ai-dev-os-integration-owner"), "utf8").catch(() => null);
    return marker === `${worktreeId}\n`;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const directory = await opendir(path);
  try {
    return await directory.read() === null;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function exactTree(options: RealGitIntegrationPortOptions, context: GitContext, commit: string): Promise<string | null> {
  return await revision(options, context, `${commit}^{tree}`);
}

async function changedPathsBetween(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  from: string,
  to: string,
): Promise<readonly string[]> {
  const result = await run(options, context, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", "-z", from, to, "--"]);
  const paths = [...exactNulRecords(result.stdout)].sort(compareIntegrationText);
  if (new Set(paths).size !== paths.length) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git returned duplicate changed paths.");
  return Object.freeze(paths);
}

async function changedPaths(options: RealGitIntegrationPortOptions, context: GitContext, request: IntegrationRequest): Promise<readonly string[]> {
  return await changedPathsBetween(options, context, request.repository.expectedTargetCommit, request.repository.expectedIntegratedTree);
}

async function sourceContributionPaths(options: RealGitIntegrationPortOptions, context: GitContext, request: IntegrationRequest): Promise<readonly string[]> {
  const history = await run(options, context, [
    "log", "-m", "--name-only", "--format=", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
    `${request.repository.expectedTargetCommit}..${request.repository.sourceCommit}`, "--",
  ]);
  const paths = exactNulRecords(history.stdout);
  const unique = [...new Set(paths)].sort(compareIntegrationText);
  if (unique.length > request.bounds.maximumPaths) throw new IntegrationError("LIMIT_EXCEEDED", "Source history path count exceeds the reviewed bound.");
  return Object.freeze(unique);
}

async function sourceObjectInventory(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  request: IntegrationRequest,
): Promise<{ readonly objectCount: number; readonly totalBytes: number }> {
  const result = await run(options, context, [
    "rev-list", "--objects", "--no-object-names", request.repository.sourceCommit, "--not", request.repository.expectedTargetCommit,
  ]);
  exactUtf8(result.stdout);
  const identities = decodeTrimmed(result.stdout).split("\n").map((line) => line.trim()).filter(Boolean);
  const expectedLength = request.repository.objectFormat === "sha1" ? 40 : 64;
  const pattern = new RegExp(`^[a-f0-9]{${expectedLength}}$`, "u");
  if (identities.some((identity) => !pattern.test(identity)) || new Set(identities).size !== identities.length) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git returned malformed or duplicate source object identities.");
  }
  if (identities.length > request.bounds.maximumFiles) {
    throw new IntegrationError("LIMIT_EXCEEDED", "Source-only object count exceeds the reviewed file bound.");
  }
  if (identities.length === 0) return Object.freeze({ objectCount: 0, totalBytes: 0 });
  const sizes = await run(
    options,
    context,
    ["cat-file", "--batch-check=%(objectsize)"],
    [0],
    undefined,
    Buffer.from(`${identities.join("\n")}\n`, "ascii"),
  );
  exactUtf8(sizes.stdout);
  const sizeLines = decodeTrimmed(sizes.stdout).split("\n");
  if (sizeLines.length !== identities.length || sizeLines.some((size) => !/^\d+$/u.test(size))) {
    throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git returned malformed source object sizes.");
  }
  let totalBytes = 0;
  for (const size of sizeLines) {
    totalBytes += Number(size);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > request.bounds.maximumBytes) {
      throw new IntegrationError("LIMIT_EXCEEDED", "Source-only object bytes exceed the reviewed bound.");
    }
  }
  return Object.freeze({ objectCount: identities.length, totalBytes });
}

async function resolutionArtifactDigest(options: RealGitIntegrationPortOptions, context: GitContext, request: IntegrationRequest): Promise<string> {
  const result = await run(options, context, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-color", request.repository.expectedTargetCommit, request.repository.expectedIntegratedTree, "--"]);
  return createHash("sha256").update(result.stdout).digest("hex");
}

async function treeInventory(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  tree: string,
): Promise<{ readonly fileCount: number; readonly totalBytes: number }> {
  const result = await run(options, context, ["ls-tree", "-r", "-l", "-z", tree]);
  const records = exactNulRecords(result.stdout);
  let totalBytes = 0;
  for (const record of records) {
    const tab = record.indexOf("\t");
    const header = tab < 0 ? "" : record.slice(0, tab);
    const path = tab < 0 ? "" : record.slice(tab + 1);
    const fields = header.split(/ +/u);
    const mode = fields[0] ?? "";
    const size = fields[3] ?? "";
    if (mode === "120000") throw new IntegrationError("CONFLICT", "Symlink entries are refused by the integration fixture.");
    if (mode === "160000") throw new IntegrationError("CONFLICT", "Gitlink/submodule entries are refused by the integration fixture.");
    if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git returned an unsafe repository path.");
    if (!/^\d+$/u.test(size)) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Git returned an unbounded tree entry.");
    totalBytes += Number(size);
    if (!Number.isSafeInteger(totalBytes)) throw new IntegrationError("LIMIT_EXCEEDED", "Tree byte total exceeds the safe integer range.");
  }
  return Object.freeze({ fileCount: records.length, totalBytes });
}

async function conflictEvidence(
  options: RealGitIntegrationPortOptions,
  context: GitContext,
  request: IntegrationRequest,
): Promise<{ readonly conflicts: readonly IntegrationConflict[]; readonly computedTree: string | null }> {
  if (request.strategy === "fast-forward") {
    const ancestor = await run(options, context, ["merge-base", "--is-ancestor", request.repository.expectedTargetCommit, request.repository.sourceCommit], [0, 1]);
    if (ancestor.exitCode !== 0) {
      if (request.bounds.maximumConflicts < 1) throw new IntegrationError("LIMIT_EXCEEDED", "Structural conflicts exceed the request bound.");
      const conflict: IntegrationConflict = Object.freeze({
        conflictId: stableIntegrationId("integration-conflict", request.runId, "structural", "non-fast-forward"),
        kind: "structural",
        path: null,
        ruleCode: "non-fast-forward",
        blocking: true,
      });
      return Object.freeze({ conflicts: Object.freeze([conflict]), computedTree: null });
    }
    return Object.freeze({ conflicts: Object.freeze([]), computedTree: request.repository.sourceTree });
  }
  // `merge-tree --write-tree` writes virtual merge objects. Keep those objects
  // out of the durable repository during the pre-effect/read-only phase by
  // using a bounded private object directory backed by the contained object
  // database as a read-only alternate. Runner cancellation is drain-aware, so
  // the directory is removed only after Git can no longer write to it.
  const privateRoot = join(options.workspaceRoot, `.integration-preflight-${request.requestDigest}`);
  const privateOwner = join(privateRoot, ".ai-dev-os-preflight-owner");
  const privateObjectDirectory = join(privateRoot, "objects");
  if (!within(options.workspaceRoot, privateRoot)) throw new IntegrationError("UNAUTHORIZED", "Private preflight object storage escaped the integration workspace.");
  if (existsSync(privateRoot)) {
    const info = await lstat(privateRoot);
    const owner = info.isDirectory() && !info.isSymbolicLink() ? await readFile(privateOwner, "utf8").catch(() => "") : "";
    const emptyPreOwnerCrashResidue = owner === "" && info.isDirectory() && !info.isSymbolicLink() && await isEmptyDirectory(privateRoot);
    if (owner !== request.requestDigest && !emptyPreOwnerCrashResidue) throw new IntegrationError("CONFLICT", "Private preflight storage is occupied by unowned residue.");
    await rm(privateRoot, { recursive: true, force: true });
  }
  await mkdir(privateRoot);
  await writeFile(privateOwner, request.requestDigest, { encoding: "utf8", flag: "wx" });
  await mkdir(privateObjectDirectory);
  let merge: Awaited<ReturnType<typeof run>>;
  try {
    const alternateObjectDirectory = join(context.discovery.commonGitDir, "objects");
    if (alternateObjectDirectory.includes(delimiter)) throw new IntegrationError("UNAUTHORIZED", "Contained object storage cannot be encoded as one exact Git alternate path.");
    const environment = Object.freeze({
      ...options.runtime.environment(),
      GIT_OBJECT_DIRECTORY: privateObjectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory,
    });
    merge = await run(options, context, ["merge-tree", "--write-tree", "--name-only", request.repository.expectedTargetCommit, request.repository.sourceCommit], [0, 1], environment);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
  exactUtf8(merge.stdout);
  const lines = decodeTrimmed(merge.stdout).split("\n").map((line) => line.trim());
  const computedTree = lines[0] && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(lines[0]) ? lines[0] : null;
  if (merge.exitCode === 0) return Object.freeze({ conflicts: Object.freeze([]), computedTree });
  const blank = lines.indexOf("");
  const paths = lines.slice(1, blank < 0 ? lines.length : blank).filter((line) => line.length > 0).sort(compareIntegrationText);
  const conflicts = paths.slice(0, request.bounds.maximumConflicts + 1).map((path) => Object.freeze({
    conflictId: stableIntegrationId("integration-conflict", request.runId, "textual", path),
    kind: "textual" as const,
    path,
    ruleCode: "textual-conflict",
    blocking: true as const,
  })).sort((left, right) => compareIntegrationText(left.conflictId, right.conflictId));
  if (conflicts.length > request.bounds.maximumConflicts) throw new IntegrationError("LIMIT_EXCEEDED", "Textual conflicts exceed the request bound.");
  return Object.freeze({ conflicts: Object.freeze(conflicts), computedTree });
}

async function removeOwnedPreflightResidue(options: RealGitIntegrationPortOptions, request: IntegrationRequest): Promise<void> {
  const privateRoot = join(options.workspaceRoot, `.integration-preflight-${request.requestDigest}`);
  if (!within(options.workspaceRoot, privateRoot)) throw new IntegrationError("UNAUTHORIZED", "Private preflight cleanup escaped the integration workspace.");
  const info = await lstat(privateRoot).catch(() => null);
  if (info === null) return;
  const owner = info.isDirectory() && !info.isSymbolicLink()
    ? await readFile(join(privateRoot, ".ai-dev-os-preflight-owner"), "utf8").catch(() => "")
    : "";
  const emptyPreOwnerCrashResidue = owner === "" && info.isDirectory() && !info.isSymbolicLink() && await isEmptyDirectory(privateRoot);
  if (owner !== request.requestDigest && !emptyPreOwnerCrashResidue) throw new IntegrationError("CONFLICT", "Private preflight residue is not owned by this exact request.");
  await rm(privateRoot, { recursive: true, force: true });
  if (await lstat(privateRoot).catch(() => null) !== null) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Private preflight residue could not be removed exactly.");
}

async function preflight(
  options: RealGitIntegrationPortOptions,
  request: IntegrationRequest,
  signal: AbortSignal,
): Promise<IntegrationPreflightResult> {
  await boundary(options, "before-preflight", signal);
  const context = await contextFor(options, signal);
  const { discovery } = context;
  await assertNoUntrackedPaths(options, context);
  await assertWritableTarget(options, context, request.repository.targetRef);
  await assertEffectGuardAbsent(options, context, request);
  const targetCommit = await revision(options, context, request.repository.targetRef);
  const targetTree = targetCommit === null ? null : await exactTree(options, context, targetCommit);
  const sourceTree = await exactTree(options, context, request.repository.sourceCommit);
  if (discovery.root !== await realpath(options.repositoryRoot) || discovery.objectFormat !== request.repository.objectFormat ||
      discovery.worktreeState !== "clean" || discovery.untrackedPaths.length !== 0 || discovery.submodules.length !== 0 ||
      targetCommit !== request.repository.expectedTargetCommit || targetTree !== request.repository.expectedTargetTree ||
      sourceTree !== request.repository.sourceTree) {
    throw new IntegrationError("TARGET_DRIFT", "Repository identity, clean state, target, source, or tree differs from the request.");
  }
  const expectedTreeExists = await revision(options, context, `${request.repository.expectedIntegratedTree}^{tree}`);
  if (expectedTreeExists === null) throw new IntegrationError("TARGET_DRIFT", "Expected integrated tree object is absent.");
  const paths = await changedPaths(options, context, request);
  if (JSON.stringify(paths) !== JSON.stringify(request.allowedPaths)) throw new IntegrationError("CONFLICT", "Changed paths differ from the exact allowed-path set.");
  const sourcePaths = await sourceContributionPaths(options, context, request);
  const allowedPathSet = new Set(request.allowedPaths);
  if (sourcePaths.length > request.bounds.maximumPaths || sourcePaths.some((path) => !allowedPathSet.has(path))) {
    throw new IntegrationError("CONFLICT", "Source history contributes a path outside the exact reviewed result scope.");
  }
  // Keep the inspection sequence single-flight. A parsing failure in one
  // result must not return while a sibling Git process is still active or
  // permit a later inspection command to start after the failure.
  const integratedInventory = await treeInventory(options, context, request.repository.expectedIntegratedTree);
  const sourceInventory = await treeInventory(options, context, request.repository.sourceTree);
  const sourceObjects = await sourceObjectInventory(options, context, request);
  const fileCount = Math.max(integratedInventory.fileCount, sourceInventory.fileCount, sourceObjects.objectCount);
  const totalBytes = Math.max(integratedInventory.totalBytes, sourceInventory.totalBytes, sourceObjects.totalBytes);
  if (paths.length > request.bounds.maximumPaths || fileCount > request.bounds.maximumFiles || totalBytes > request.bounds.maximumBytes) {
    throw new IntegrationError("LIMIT_EXCEEDED", "Repository change exceeds the request bounds.");
  }
  const conflict = await conflictEvidence(options, context, request);
  if (conflict.conflicts.some((item) => item.path !== null && !allowedPathSet.has(item.path))) {
    throw new IntegrationError("CONFLICT", "Conflict evidence references a path outside the exact reviewed scope.");
  }
  if (conflict.conflicts.length === 0 && conflict.computedTree !== request.repository.expectedIntegratedTree) throw new IntegrationError("CONFLICT", "Computed integration tree differs from the reviewed tree.");
  if (conflict.conflicts.length > 0 && request.resolutionProposal !== null && request.resolutionProposal.resultingTree !== request.repository.expectedIntegratedTree) throw new IntegrationError("CONFLICT", "Conflicted merge has a mismatched reviewed resulting tree.");
  if (request.resolutionProposal !== null) {
    const actualArtifactDigest = await resolutionArtifactDigest(options, context, request);
    if (request.resolutionProposal.patchArtifactDigest !== actualArtifactDigest) {
      throw new IntegrationError("CONFLICT", "Reviewed resolution artifact does not match the exact target-to-result patch bytes.", {
        expectedArtifactDigest: request.resolutionProposal.patchArtifactDigest,
        actualArtifactDigest,
      });
    }
  }
  const checkedAt = options.now();
  const projection = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    preflightId: stableIntegrationId("integration-preflight", request.runId, request.requestDigest, checkedAt),
    requestDigest: request.requestDigest,
    repositoryId: request.repository.repositoryId,
    targetRef: request.repository.targetRef,
    targetCommit,
    targetTree,
    sourceCommit: request.repository.sourceCommit,
    sourceTree,
    clean: true,
    changedPaths: paths,
    fileCount,
    totalBytes,
    conflicts: conflict.conflicts,
    checkedAt,
  };
  return parseIntegrationPreflightResult(Object.freeze({ ...projection, preflightDigest: integrationDigest(projection) }));
}

async function createWorktree(options: RealGitIntegrationPortOptions, context: GitContext, intent: IntegrationEffectIntent, request: IntegrationRequest): Promise<{ readonly worktreeId: string; readonly path: string }> {
  const worktreeId = stableIntegrationId("integration-worktree", intent.intentId);
  const path = join(resolve(options.workspaceRoot), worktreeId.replace(":", "-"));
  const claimPath = worktreeOwnerClaimPath(options, worktreeId);
  if (!within(options.fixtureRoot, path)) throw new IntegrationError("INVALID_INPUT", "Derived integration worktree escapes the fixture root.");
  await mkdir(options.workspaceRoot, { recursive: true });
  if (await lstat(path).catch(() => null) !== null || await lstat(claimPath).catch(() => null) !== null || await isRegisteredWorktree(options, context, path)) {
    throw new IntegrationError("CONFLICT", "Derived integration worktree identity is already occupied.");
  }
  await writeFile(claimPath, `${worktreeId}\n`, { encoding: "utf8", flag: "wx" });
  await run(options, context, ["worktree", "add", "--detach", "--no-checkout", path, request.repository.expectedTargetCommit]);
  await boundary(options, "after-worktree-register", context.signal);
  await writeFile(join(path, ".ai-dev-os-integration-owner"), `${worktreeId}\n`, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ worktreeId, path });
}

async function verifyImmediateTarget(options: RealGitIntegrationPortOptions, context: GitContext, request: IntegrationRequest): Promise<void> {
  const latest = await contextFor(options, context.signal);
  await assertWritableTarget(options, latest, request.repository.targetRef);
  const target = await revision(options, latest, request.repository.targetRef);
  const targetTree = target === null ? null : await exactTree(options, latest, target);
  const sourceTree = await exactTree(options, latest, request.repository.sourceCommit);
  if (latest.discovery.worktreeState !== "clean" || latest.discovery.untrackedPaths.length !== 0 || latest.discovery.submodules.length !== 0 ||
      target !== request.repository.expectedTargetCommit || targetTree !== request.repository.expectedTargetTree || sourceTree !== request.repository.sourceTree) {
    throw new IntegrationError("TARGET_DRIFT", "Repository changed after validation and before the atomic ref update.");
  }
}

async function integrate(
  options: RealGitIntegrationPortOptions,
  intent: IntegrationEffectIntent,
  request: IntegrationRequest,
  signal: AbortSignal,
): Promise<IntegrationReceipt> {
  await preflight(options, request, signal);
  const context = await contextFor(options, signal);
  await armEffectGuard(options, context, intent, request);
  const workspace = await createWorktree(options, context, intent, request);
  await boundary(options, "after-worktree-create", signal);
  const indexFile = join(workspace.path, "integration.index");
  const env = options.runtime.environment({ indexFile, optionalLocks: true });
  await boundary(options, "before-index-update", signal);
  await run(options, context, ["read-tree", request.repository.expectedIntegratedTree], [0], env);
  await boundary(options, "after-index-update", signal);
  await boundary(options, "before-write-tree", signal);
  const writtenTreeBytes = (await run(options, context, ["write-tree"], [0], env)).stdout;
  exactUtf8(writtenTreeBytes);
  const writtenTree = decodeTrimmed(writtenTreeBytes);
  const expectedIdentityLength = request.repository.objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[a-f0-9]{${expectedIdentityLength}}$`, "u").test(writtenTree)) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Private index returned a malformed tree identity.");
  if (writtenTree !== request.repository.expectedIntegratedTree) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Private index wrote a different tree.", { expectedTree: request.repository.expectedIntegratedTree });
  await boundary(options, "after-write-tree", signal);
  let integratedCommit = request.repository.sourceCommit;
  if (request.strategy === "merge") {
    const commit = await run(
      options,
      context,
      ["commit-tree", writtenTree, "-p", request.repository.expectedParents[0]!, "-p", request.repository.expectedParents[1]!, "-m", "AI Development OS serialized integration"],
      [0],
      options.runtime.environment({
        authorName: "AI Development OS Integrator",
        authorEmail: "integrator@ai-dev-os.invalid",
        authorDate: request.repository.mergeCommitTimestamp!,
      }),
    );
    integratedCommit = decodeTrimmed(commit.stdout);
    if (integratedCommit !== request.repository.expectedIntegratedCommit) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Deterministic merge commit differs from the reviewed commit identity.");
    await boundary(options, "after-commit-create", signal);
  }
  await verifyImmediateTarget(options, context, request);
  await boundary(options, "before-ref-update", signal);
  await publishWithEffectGuard(options, context, intent, request, integratedCommit);
  await boundary(options, "after-ref-update", signal);
  const actual = await revision(options, context, request.repository.targetRef);
  const actualTree = actual === null ? null : await exactTree(options, context, actual);
  if (actual !== integratedCommit || actualTree !== request.repository.expectedIntegratedTree) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Atomic local ref update did not publish the exact reviewed commit and tree.");
  await boundary(options, "before-receipt", signal);
  const committedAt = options.now();
  const artifactDigest = request.candidateArtifact.artifactDigest;
  const projection = {
    schemaVersion: INTEGRATION_SCHEMA_VERSION,
    receiptId: stableIntegrationId("integration-receipt", intent.intentDigest, integratedCommit),
    intentDigest: intent.intentDigest,
    repositoryId: request.repository.repositoryId,
    targetRef: request.repository.targetRef,
    previousTargetCommit: request.repository.expectedTargetCommit,
    integratedCommit,
    integratedTree: actualTree,
    parents: request.strategy === "merge" ? request.repository.expectedParents : Object.freeze([]),
    strategy: request.strategy,
    refUpdated: true as const,
    worktreeId: workspace.worktreeId,
    changedPaths: request.allowedPaths,
    artifactDigest,
    timingBasis: "observed" as const,
    committedAt,
  };
  return parseIntegrationReceipt(Object.freeze({ ...projection, receiptDigest: integrationDigest(projection) }));
}

async function reconcile(
  options: RealGitIntegrationPortOptions,
  intent: IntegrationEffectIntent,
  request: IntegrationRequest,
  persistedReceipt: IntegrationReceipt | null,
  signal: AbortSignal,
): Promise<IntegrationRecoveryState> {
  const context = await contextFor(options, signal);
  const effectGuardState = await revokeEffectGuard(options, context, intent, request);
  await removeOwnedPreflightResidue(options, request);
  await assertWritableTarget(options, context, request.repository.targetRef);
  const target = await revision(options, context, request.repository.targetRef);
  const tree = target === null ? null : await exactTree(options, context, target);
  const observedAt = options.now();
  let state: IntegrationRecoveryState["state"];
  let receipt: IntegrationReceipt | null = null;
  if (target === request.repository.expectedIntegratedCommit && tree === request.repository.expectedIntegratedTree) {
    state = "ref-published";
    if (persistedReceipt !== null) receipt = persistedReceipt;
    else {
      const committedAt = observedAt;
      const worktreeId = stableIntegrationId("integration-worktree", intent.intentId);
      const projection = {
        schemaVersion: INTEGRATION_SCHEMA_VERSION,
        receiptId: stableIntegrationId("integration-receipt", intent.intentDigest, target),
        intentDigest: intent.intentDigest,
        repositoryId: request.repository.repositoryId,
        targetRef: request.repository.targetRef,
        previousTargetCommit: request.repository.expectedTargetCommit,
        integratedCommit: target,
        integratedTree: tree,
        parents: request.strategy === "merge" ? request.repository.expectedParents : Object.freeze([]),
        strategy: request.strategy,
        refUpdated: true as const,
        worktreeId,
        changedPaths: request.allowedPaths,
        artifactDigest: request.candidateArtifact.artifactDigest,
        timingBasis: "recovered-observation" as const,
        committedAt,
      };
      receipt = parseIntegrationReceipt(Object.freeze({ ...projection, receiptDigest: integrationDigest(projection) }));
    }
  } else if (persistedReceipt !== null) state = "diverged";
  else if (target === request.repository.expectedTargetCommit && tree === request.repository.expectedTargetTree && effectGuardState === "revoked") {
    if (request.strategy === "merge" && await revision(options, context, `${request.repository.expectedIntegratedCommit}^{commit}`) !== null) state = "commit-created";
    else state = "no-effect";
  } else state = "diverged";
  const projection = {
    state,
    effectGuardState,
    intentDigest: intent.intentDigest,
    observedTargetCommit: target,
    observedTargetTree: tree,
    receipt,
    observedAt,
  };
  return parseIntegrationRecoveryState(Object.freeze({ ...projection, recoveryDigest: integrationDigest(projection) }));
}

function createRealGitIntegrationPortUnchecked(options: RealGitIntegrationPortOptions): IntegrationGitPort {
  const canonicalRoute = canonicalRealGitRoute(options);
  const routeFingerprint = integrationDigest({
    portId: "integration-git:real-disposable-fixture",
    schemaVersion: 1,
    ...canonicalRoute,
  });
  const targetFingerprint = realGitIntegrationTargetFingerprint(canonicalRoute);
  const capturedOptions: CapturedRealGitIntegrationPortOptions = Object.freeze({
    runtime: options.runtime,
    ...canonicalRoute,
    capturedRouteFingerprint: routeFingerprint,
    capturedTargetFingerprint: targetFingerprint,
    now: options.now,
    ...(options.failAt === undefined ? {} : { failAt: options.failAt }),
    ...(options.onBoundary === undefined ? {} : { onBoundary: options.onBoundary }),
  });
  const port: IntegrationGitPort = {
    portId: "integration-git:real-disposable-fixture",
    schemaVersion: 1,
    routeFingerprint,
    targetFingerprint,
    async preflight(request, signal) {
      return await finitePortOperation("preflight", async () => {
        if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git preflight was aborted.");
        return await preflight(capturedOptions, request, signal);
      });
    },
    async integrate(intent, request, signal) {
      return await finitePortOperation("integration", async () => {
        if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git integration was aborted.");
        return await integrate(capturedOptions, intent, request, signal);
      });
    },
    async reconcile(intent, request, persistedReceipt, signal) {
      return await finitePortOperation("reconciliation", async () => {
        if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git reconciliation was aborted.");
        return await reconcile(capturedOptions, intent, request, persistedReceipt, signal);
      });
    },
    async cleanup(worktreeId, signal): Promise<IntegrationCleanupResult> {
      return await finitePortOperation("cleanup", async () => {
        if (signal.aborted) throw new IntegrationError("TIMEOUT", "Git cleanup was aborted.");
        if (!/^integration-worktree:[a-f0-9]{64}$/u.test(worktreeId)) throw new IntegrationError("INVALID_INPUT", "Cleanup requires an exact derived integration worktree identity.");
        const context = await contextFor(capturedOptions, signal);
        const path = join(resolve(capturedOptions.workspaceRoot), worktreeId.replace(":", "-"));
        const claimPath = worktreeOwnerClaimPath(capturedOptions, worktreeId);
        if (!within(capturedOptions.workspaceRoot, path)) throw new IntegrationError("INVALID_INPUT", "Cleanup target escapes the integration workspace root.");
        const claimInfo = await lstat(claimPath).catch(() => null);
        const exactClaim = await hasExactWorktreeOwnerClaim(capturedOptions, worktreeId);
        if (claimInfo !== null && !exactClaim) throw new IntegrationError("INVALID_INPUT", "Cleanup ownership claim is not exact.");
        const info = await lstat(path).catch(() => null);
        if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) throw new IntegrationError("INVALID_INPUT", "Cleanup target is not an exact integration worktree directory.");
        if (info !== null && !within(await realpath(capturedOptions.workspaceRoot), await realpath(path))) throw new IntegrationError("INVALID_INPUT", "Cleanup target resolves outside the integration workspace root.");
        if (info === null) {
          const registered = await isRegisteredWorktree(capturedOptions, context, path);
          if (!registered) {
            if (exactClaim) await rm(claimPath, { force: true });
            return Object.freeze({ worktreeId, cleaned: true, preservedEvidence: false, failureCode: null, observedAt: capturedOptions.now() });
          }
          return Object.freeze({
            worktreeId,
            cleaned: false,
            preservedEvidence: false,
            failureCode: "cleanup-failed",
            observedAt: capturedOptions.now(),
          });
        }
        const exactRegistered = await isExactRegisteredWorktree(capturedOptions, context, path);
        const exactPreserved = await isExactPreservedWorktree(capturedOptions, context, path, worktreeId);
        if (!exactClaim && !exactPreserved) {
          throw new IntegrationError("INVALID_INPUT", "Cleanup target is not the exact registered integration worktree.");
        }
        try {
          await boundary(capturedOptions, "cleanup", signal);
          if (exactRegistered) await run(capturedOptions, context, ["worktree", "remove", "--force", path]);
          await rm(path, { recursive: true, force: true });
          if (exactClaim) await rm(claimPath, { force: true });
          return Object.freeze({ worktreeId, cleaned: true, preservedEvidence: false, failureCode: null, observedAt: capturedOptions.now() });
        } catch {
          const remaining = await lstat(path).catch(() => null);
          if (remaining === null) {
            if (!await isRegisteredWorktree(capturedOptions, context, path).catch(() => true)) {
              try {
                if (exactClaim) {
                  if (!await hasExactWorktreeOwnerClaim(capturedOptions, worktreeId)) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Cleanup ownership claim changed after worktree removal.");
                  await rm(claimPath, { force: true });
                  if (await lstat(claimPath).catch(() => null) !== null) throw new IntegrationError("GIT_BOUNDARY_FAILURE", "Cleanup ownership claim could not be removed exactly.");
                }
              } catch {
                return Object.freeze({ worktreeId, cleaned: false, preservedEvidence: false, failureCode: "cleanup-failed", observedAt: capturedOptions.now() });
              }
              return Object.freeze({ worktreeId, cleaned: true, preservedEvidence: false, failureCode: null, observedAt: capturedOptions.now() });
            }
          }
          const preservedEvidence = await isExactPreservedWorktree(capturedOptions, context, path, worktreeId) ||
            (await isExactRegisteredWorktree(capturedOptions, context, path) && await hasExactWorktreeOwnerClaim(capturedOptions, worktreeId));
          return Object.freeze({ worktreeId, cleaned: false, preservedEvidence, failureCode: "cleanup-failed", observedAt: capturedOptions.now() });
        }
      });
    },
  };
  return Object.freeze(port);
}

export function createRealGitIntegrationPort(options: RealGitIntegrationPortOptions): IntegrationGitPort {
  return finiteRouteInspection(() => createRealGitIntegrationPortUnchecked(options));
}
