import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { createSqlitePersistenceAdapter } from "@ai-dev-os/persistence-sqlite";
import { decodeTrimmed, type GitRuntime } from "@ai-dev-os/workspace";
import { describe, expect, it } from "vitest";
import { fixtureCase, type RealGitFixtureCase } from "./real-git-fixture-case.js";
import {
  IntegrationError,
  integrationDigest,
  stableIntegrationId,
  type IntegrationAuthorityConfiguration,
  type IntegrationRequest,
  type IntegrationValidationPort,
} from "../src/index.js";
import {
  REAL_GIT_FAILURE_BOUNDARIES,
  createIntegrationServiceForTesting,
  createRealGitIntegrationPort,
  realGitIntegrationRouteFingerprint,
  realGitIntegrationTargetFingerprint,
  type RealGitFailureBoundary,
} from "../src/testing/index.js";
import { T0, T1, T2, T3, T4, TEST_CLOCK, authorityFor, command, fakePorts, requestInput, validationResult } from "./fixtures.js";

interface Fixture {
  readonly owner: RealGitFixtureCase;
  readonly root: string;
  readonly repository: string;
  readonly workspaceRoot: string;
  readonly runtime: GitRuntime;
  readonly targetCommit: string;
  readonly targetTree: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
}

const FIXTURE_PROTECTED_REFS = Object.freeze(["refs/heads/fixture-admin"]);
const RECOVERY_AT = "2026-08-11T09:05:00.000Z";
const RECOVERY_CLOCK = Object.freeze({ now: () => new Date(RECOVERY_AT) });

async function git(runtime: GitRuntime, cwd: string, args: readonly string[], authorAt = T0): Promise<string> {
  const result = await runtime.runner.run([...runtime.configArguments({ allowLocalFileProtocol: true }), "-C", cwd, ...args], {
    cwd,
    env: runtime.environment({
      authorName: "AI Development OS Fixture",
      authorEmail: "fixture@ai-dev-os.invalid",
      authorDate: authorAt,
    }),
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Fixture Git command failed with exit code ${result.exitCode}.`);
  }
  return decodeTrimmed(result.stdout);
}

async function gitTolerated(runtime: GitRuntime, cwd: string, args: readonly string[], toleratedExitCodes: readonly number[]): Promise<{ readonly exitCode: number; readonly output: string }> {
  const result = await runtime.runner.run([...runtime.configArguments({ allowLocalFileProtocol: true }), "-C", cwd, ...args], {
    cwd,
    env: runtime.environment({ authorName: "AI Development OS Fixture", authorEmail: "fixture@ai-dev-os.invalid", authorDate: T2 }),
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
    toleratedExitCodes,
  });
  return Object.freeze({ exitCode: result.exitCode, output: decodeTrimmed(result.stdout) });
}

async function fileInventory(root: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await fileInventory(join(root, entry.name), relativePath));
    else files.push(relativePath);
  }
  return Object.freeze(files.sort());
}

async function expectedIntegratorCommit(runtime: GitRuntime, cwd: string, tree: string, target: string, source: string): Promise<string> {
  const privateObjects = await mkdtemp(join(resolve(cwd, ".."), ".expected-integration-objects-"));
  const mainObjects = resolve(cwd, await git(runtime, cwd, ["rev-parse", "--git-path", "objects"]));
  // Private objects remain under the case-owned root until complete quiescence.
  const result = await runtime.runner.run([
    ...runtime.configArguments(), "-C", cwd, "commit-tree", tree, "-p", target, "-p", source,
    "-m", "AI Development OS serialized integration",
  ], {
    cwd,
    env: runtime.environment({
      authorName: "AI Development OS Integrator",
      authorEmail: "integrator@ai-dev-os.invalid",
      authorDate: T2,
      objectDirectory: privateObjects,
      alternateObjectDirectories: [mainObjects],
    }),
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
  });
  if (result.exitCode !== 0) throw new Error("fixture integrator commit could not be derived");
  return decodeTrimmed(result.stdout);
}

function reviseRequest(request: IntegrationRequest, overrides: Readonly<Record<string, unknown>>): IntegrationRequest {
  const projection = { ...request, ...overrides } as Record<string, unknown>;
  delete projection["requestDigest"];
  return Object.freeze({ ...projection, requestDigest: integrationDigest(projection) }) as unknown as IntegrationRequest;
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function reviewedPatchDigest(fixture: Fixture, request: IntegrationRequest): Promise<string> {
  const result = await fixture.runtime.runner.run([
    ...fixture.runtime.configArguments(), "-C", fixture.repository, "diff", "--no-ext-diff", "--binary", "--full-index", "--no-color",
    request.repository.expectedTargetCommit, request.repository.expectedIntegratedTree, "--",
  ], {
    cwd: fixture.root,
    env: fixture.runtime.environment(),
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return createHash("sha256").update(result.stdout).digest("hex");
}

async function repositoryFingerprint(runtime: GitRuntime, repository: string): Promise<Readonly<Record<string, string>>> {
  const gitDir = await git(runtime, repository, ["rev-parse", "--absolute-git-dir"]);
  return Object.freeze({
    head: await git(runtime, repository, ["rev-parse", "HEAD"]),
    tree: await git(runtime, repository, ["rev-parse", "HEAD^{tree}"]),
    status: await git(runtime, repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: await git(runtime, repository, ["show-ref", "--head"]),
    index: await fileHash(join(gitDir, "index")),
  });
}

async function createFixture(owner: RealGitFixtureCase, kind: "fast-forward" | "merge" | "conflict" = "fast-forward"): Promise<Fixture> {
  const root = await owner.createRoot();
  const repository = join(root, "repository");
  const workspaceRoot = join(root, "integration-worktrees");
  const runtime = await owner.createRuntime(root);
  await mkdir(repository, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await git(runtime, repository, ["init", "--initial-branch=fixture-admin"]);
  await writeFile(join(repository, "base.txt"), "base\n", "utf8");
  await writeFile(join(repository, ".gitattributes"), "*.txt filter=evil diff=evil merge=evil\n", "utf8");
  await git(runtime, repository, ["add", "--", "base.txt", ".gitattributes"]);
  await git(runtime, repository, ["commit", "-m", "base"], T0);
  const baseCommit = await git(runtime, repository, ["rev-parse", "HEAD"]);

  if (kind === "fast-forward") {
    await git(runtime, repository, ["update-ref", "refs/heads/integration-target", baseCommit]);
    await writeFile(join(repository, "feature.txt"), "feature\n", "utf8");
    await git(runtime, repository, ["add", "--", "feature.txt"]);
    await git(runtime, repository, ["commit", "-m", "source"], T1);
    const sourceCommit = await git(runtime, repository, ["rev-parse", "HEAD"]);
    return fixtureResult(owner, root, repository, workspaceRoot, runtime, baseCommit, sourceCommit);
  }

  await git(runtime, repository, ["switch", "-c", "target-builder", baseCommit]);
  if (kind === "merge") await writeFile(join(repository, "target.txt"), "target\n", "utf8");
  else await writeFile(join(repository, "base.txt"), "target\n", "utf8");
  await git(runtime, repository, ["add", "--", kind === "merge" ? "target.txt" : "base.txt"]);
  await git(runtime, repository, ["commit", "-m", "target"], T1);
  const targetCommit = await git(runtime, repository, ["rev-parse", "HEAD"]);
  await git(runtime, repository, ["update-ref", "refs/heads/integration-target", targetCommit]);

  await git(runtime, repository, ["switch", "fixture-admin"]);
  if (kind === "merge") await writeFile(join(repository, "source.txt"), "source\n", "utf8");
  else await writeFile(join(repository, "base.txt"), "source\n", "utf8");
  await git(runtime, repository, ["add", "--", kind === "merge" ? "source.txt" : "base.txt"]);
  await git(runtime, repository, ["commit", "-m", "source"], T1);
  const sourceCommit = await git(runtime, repository, ["rev-parse", "HEAD"]);
  return fixtureResult(owner, root, repository, workspaceRoot, runtime, targetCommit, sourceCommit);
}

async function fixtureResult(owner: RealGitFixtureCase, root: string, repository: string, workspaceRoot: string, runtime: GitRuntime, targetCommit: string, sourceCommit: string): Promise<Fixture> {
  const targetTree = await git(runtime, repository, ["rev-parse", `${targetCommit}^{tree}`]);
  const sourceTree = await git(runtime, repository, ["rev-parse", `${sourceCommit}^{tree}`]);
  return Object.freeze({
    owner,
    root,
    repository,
    workspaceRoot,
    runtime,
    targetCommit,
    targetTree,
    sourceCommit,
    sourceTree,
  });
}

async function requestFor(fixture: Fixture, strategy: "fast-forward" | "merge" = "fast-forward"): Promise<IntegrationRequest> {
  let expectedIntegratedTree = fixture.sourceTree;
  let expectedIntegratedCommit = fixture.sourceCommit;
  let expectedParents: readonly string[] = [];
  if (strategy === "merge") {
    const merge = await gitTolerated(fixture.runtime, fixture.repository, ["merge-tree", "--write-tree", fixture.targetCommit, fixture.sourceCommit], [0, 1]);
    expectedIntegratedTree = merge.output.split("\n")[0]!.trim();
    expectedParents = Object.freeze([fixture.targetCommit, fixture.sourceCommit]);
    expectedIntegratedCommit = await expectedIntegratorCommit(fixture.runtime, fixture.repository, expectedIntegratedTree, fixture.targetCommit, fixture.sourceCommit);
  }
  const changed = await git(fixture.runtime, fixture.repository, ["diff", "--name-only", fixture.targetCommit, expectedIntegratedTree, "--"]);
  const allowedPaths = Object.freeze(changed.split("\n").filter(Boolean).sort());
  return requestInput({
    repository: Object.freeze({
      repositoryId: "repository:real-fixture",
      objectFormat: "sha1",
      targetRef: "refs/heads/integration-target",
      expectedTargetCommit: fixture.targetCommit,
      expectedTargetTree: fixture.targetTree,
      sourceCommit: fixture.sourceCommit,
      sourceTree: fixture.sourceTree,
      expectedIntegratedCommit,
      expectedIntegratedTree,
      expectedParents,
      mergeCommitTimestamp: strategy === "merge" ? T2 : null,
    }),
    gitPortId: "integration-git:real-disposable-fixture",
    gitPortSchemaVersion: 1,
    gitRouteFingerprint: realGitIntegrationRouteFingerprint({ repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS }),
    gitTargetFingerprint: realGitIntegrationTargetFingerprint({ repositoryRoot: fixture.repository, fixtureRoot: fixture.root }),
    strategy,
    allowedPaths,
  });
}

async function requestForCurrentSource(fixture: Fixture, slug: string): Promise<IntegrationRequest> {
  const template = await requestFor(fixture);
  const sourceCommit = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD"]);
  const sourceTree = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD^{tree}"]);
  const changed = await git(fixture.runtime, fixture.repository, ["diff", "--no-renames", "--name-only", fixture.targetCommit, sourceTree, "--"]);
  return reviseRequest(template, {
    runId: `integration:b3-${slug}`,
    idempotencyKey: `request:b3-${slug}`,
    repository: {
      ...template.repository,
      sourceCommit,
      sourceTree,
      expectedIntegratedCommit: sourceCommit,
      expectedIntegratedTree: sourceTree,
    },
    allowedPaths: Object.freeze(changed.split("\n").filter(Boolean).sort()),
  });
}

function times(): () => string {
  const values = [T2, T2, T4, T4, T4, T4, T4];
  return () => values.shift() ?? T4;
}

function validationAt(request: IntegrationRequest, evaluatedAt: string): IntegrationValidationPort {
  const base = fakePorts(request).validation;
  return Object.freeze({
    ...base,
    async validate(input, signal) {
      const result = await base.validate(input, signal);
      const projection = {
        ...result,
        resultId: stableIntegrationId("validation-result", input.request.runId, input.phase, evaluatedAt),
        evaluatedAt,
      } as Record<string, unknown>;
      delete projection["resultDigest"];
      return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
    },
  });
}

function recoveryService(
  fixture: Fixture,
  persistence: Parameters<typeof createIntegrationServiceForTesting>[0]["persistence"],
  request: IntegrationRequest,
  onBoundary?: (boundary: RealGitFailureBoundary) => void | Promise<void>,
) {
  const port = createRealGitIntegrationPort({
    runtime: fixture.runtime,
    repositoryRoot: fixture.repository,
    fixtureRoot: fixture.root,
    workspaceRoot: fixture.workspaceRoot,
    protectedRefs: FIXTURE_PROTECTED_REFS,
    now: () => RECOVERY_AT,
    ...(onBoundary === undefined ? {} : { onBoundary }),
  });
  return createIntegrationServiceForTesting({
    persistence,
    clock: RECOVERY_CLOCK,
    git: port,
    validation: validationAt(request, RECOVERY_AT),
    authorityConfiguration: authorityFor(request),
  });
}

async function executeFixture(
  fixture: Fixture,
  request: IntegrationRequest,
  failAt?: RealGitFailureBoundary,
  onBoundary?: (boundary: RealGitFailureBoundary) => void | Promise<void>,
  authority: IntegrationAuthorityConfiguration = authorityFor(request),
  validationOverride?: IntegrationValidationPort,
) {
  const persistence = fixture.owner.ownPersistence(createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } }));
  const validation = validationOverride ?? fakePorts(request).validation;
  const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times(), ...(failAt === undefined ? {} : { failAt }), ...(onBoundary === undefined ? {} : { onBoundary }) });
  const service = createIntegrationServiceForTesting({ persistence, clock: TEST_CLOCK, git: port, validation, authorityConfiguration: authority });
  await service.accept(request);
  await service.claim(command(request.runId, "claim:real", 1, "claim", T1));
  const prepared = await service.prepare(command(request.runId, "prepare:real", 2, "fenced", T2));
  return { persistence, service, prepared, port };
}

describe("real disposable Git integration boundary", () => {
  it("maps direct testing-port filesystem failures to finite path-free errors", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const canary = "SECRET_FILESYSTEM_PATH_CANARY";
    const constructorError = (() => {
      try {
        createRealGitIntegrationPort({
          runtime: fixture.runtime,
          repositoryRoot: join(fixture.root, canary),
          fixtureRoot: fixture.root,
          workspaceRoot: fixture.workspaceRoot,
          protectedRefs: FIXTURE_PROTECTED_REFS,
          now: times(),
        });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(constructorError).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify((constructorError as IntegrationError).toJSON())).not.toContain(canary);

    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const request = await requestFor(fixture);
    await rm(join(fixture.repository, ".git", "HEAD"));
    const operationError = await port.preflight(request, new AbortController().signal).catch((error: unknown) => error);
    expect(operationError).toBeInstanceOf(IntegrationError);
    expect(JSON.stringify((operationError as IntegrationError).toJSON())).not.toContain(fixture.root);
  }));

  it("refuses configured protected refs even while a different branch is checked out", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const protectedRefs = Object.freeze(["refs/heads/integration-target"]);
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs, now: times() });
    const request = reviseRequest(await requestFor(fixture), { gitRouteFingerprint: port.routeFingerprint });
    await expect(port.preflight(request, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const caseVariant = reviseRequest(request, { repository: { ...request.repository, targetRef: "refs/heads/INTEGRATION-TARGET" } });
    await expect(port.preflight(caseVariant, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
  }));

  it("refuses symbolic target aliases and branches checked out in any linked worktree", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const request = await requestFor(fixture);
    await git(fixture.runtime, fixture.repository, ["symbolic-ref", "refs/heads/integration-alias", request.repository.targetRef]);
    const aliasRequest = reviseRequest(request, { repository: { ...request.repository, targetRef: "refs/heads/integration-alias" } });
    await expect(port.preflight(aliasRequest, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const linked = join(fixture.root, "checked-out-target");
    await git(fixture.runtime, fixture.repository, ["worktree", "add", "--force", linked, "integration-target"]);
    await expect(port.preflight(request, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
    await git(fixture.runtime, fixture.repository, ["worktree", "remove", "--force", linked]);
  }), 30_000);

  it("drains an abort at the final pre-ref boundary and never performs a late update", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    const controller = new AbortController();
    const prepared = await executeFixture(fixture, request);
    const abortingPort = createRealGitIntegrationPort({
      runtime: fixture.runtime,
      repositoryRoot: fixture.repository,
      fixtureRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      protectedRefs: FIXTURE_PROTECTED_REFS,
      now: times(),
      onBoundary(boundary) { if (boundary === "before-ref-update") controller.abort(); },
    });
    await expect(abortingPort.integrate(prepared.prepared.intent!, request, controller.signal)).rejects.toBeInstanceOf(IntegrationError);
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
    await abortingPort.cleanup(stableIntegrationId("integration-worktree", prepared.prepared.intent!.intentId), new AbortController().signal);
    await prepared.persistence.close();
  }), 60_000);

  it("revokes the Git-side effect guard before terminal no-effect recovery so an orphaned updater cannot publish late", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    let releaseBoundary!: () => void;
    let announceBoundary!: () => void;
    const released = new Promise<void>((resolveRelease) => { releaseBoundary = resolveRelease; });
    const announced = new Promise<void>((resolveAnnounce) => { announceBoundary = resolveAnnounce; });
    const persistence = owner.ownPersistence(createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } }));
    const firstPort = createRealGitIntegrationPort({
      runtime: fixture.runtime,
      repositoryRoot: fixture.repository,
      fixtureRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      protectedRefs: FIXTURE_PROTECTED_REFS,
      now: times(),
      async onBoundary(name) {
        if (name === "before-ref-update") {
          announceBoundary();
          await released;
        }
      },
    });
    const validation = fakePorts(request).validation;
    const authorityConfiguration = authorityFor(request);
    const firstService = createIntegrationServiceForTesting({ persistence, clock: TEST_CLOCK, git: firstPort, validation, authorityConfiguration });
    await firstService.accept(request);
    await firstService.claim(command(request.runId, "claim:guard-race", 1, "claim", T1));
    await firstService.prepare(command(request.runId, "prepare:guard-race", 2, "fenced", T2));
    const executing = firstService.execute(command(request.runId, "execute:guard-race", 3, "fenced", T3));
    void executing.catch(() => undefined);
    try {
      await Promise.race([announced, executing]);

      const recoveringService = recoveryService(fixture, persistence, request);
      const failed = await recoveringService.reconcile(command(request.runId, "reconcile:guard-race", 4, "fenced", RECOVERY_AT));
      expect(failed).toMatchObject({ status: "failed", lastFailureCode: "recovery-no-effect" });
      releaseBoundary();
      await expect(executing).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
      expect((await recoveringService.get(request.runId))?.status).toBe("failed");
    } finally {
      releaseBoundary();
      await Promise.allSettled([executing]);
    }
    await persistence.close();
  }), 30_000);

  it("performs exact clean fast-forward and non-fast-forward integration without changing the real repository under test", fixtureCase(async (owner) => {
    const realRepository = resolve(import.meta.dirname, "../../..");
    for (const strategy of ["fast-forward", "merge"] as const) {
      const fixture = await createFixture(owner, strategy);
      const before = await repositoryFingerprint(fixture.runtime, realRepository);
      const request = await requestFor(fixture, strategy);
      if (strategy === "merge") {
        const absent = await gitTolerated(fixture.runtime, fixture.repository, ["cat-file", "-e", `${request.repository.expectedIntegratedCommit}^{commit}`], [0, 1, 128]);
        expect(absent.exitCode).not.toBe(0);
      }
      const seen: RealGitFailureBoundary[] = [];
      const { persistence, service, prepared } = await executeFixture(fixture, request, undefined, (name) => { seen.push(name); });
      expect(prepared.status).toBe("prepared");
      let completed;
      try {
        completed = await service.execute(command(request.runId, `execute:${strategy}`, 3, "fenced", T3));
      } catch (error) {
        throw new Error(`real Git integration failed after boundaries: ${seen.join(",")}`, { cause: error });
      }
      expect(completed).toMatchObject({ status: "completed", productionEnabled: false });
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedIntegratedCommit);
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", `${request.repository.targetRef}^{tree}`])).toBe(request.repository.expectedIntegratedTree);
      if (strategy === "merge") {
        expect((await gitTolerated(fixture.runtime, fixture.repository, ["cat-file", "-e", `${request.repository.expectedIntegratedCommit}^{commit}`], [0, 1, 128])).exitCode).toBe(0);
        const parents = (await git(fixture.runtime, fixture.repository, ["show", "-s", "--format=%P", request.repository.expectedIntegratedCommit])).split(" ");
        expect(parents).toEqual(request.repository.expectedParents);
      }
      expect(await service.execute(command(request.runId, `execute:${strategy}`, 3, "fenced", T3))).toEqual(completed);
      expect(await repositoryFingerprint(fixture.runtime, realRepository)).toEqual(before);
      await persistence.close();

    }
  }), 60_000);

  it("classifies a durable published receipt followed by a target reset as divergence", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    const { persistence, service } = await executeFixture(fixture, request);
    const completed = await service.execute(command(request.runId, "execute:published-then-reset", 3, "fenced", T3));
    expect(completed).toMatchObject({ status: "completed" });
    await git(fixture.runtime, fixture.repository, ["update-ref", "--no-deref", request.repository.targetRef, request.repository.expectedTargetCommit, request.repository.expectedIntegratedCommit]);
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: () => RECOVERY_AT });
    const recovery = await port.reconcile(completed.intent!, request, completed.receipt!, new AbortController().signal);
    expect(recovery).toMatchObject({ state: "diverged", receipt: null, observedTargetCommit: request.repository.expectedTargetCommit });
    await persistence.close();
  }), 30_000);

  it("never reports no-effect when an absent effect guard could mean publish followed by reset", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    const run = await executeFixture(fixture, request, "before-receipt");
    await expect(run.service.execute(command(request.runId, "execute:publish-reset-no-receipt", 3, "fenced", T3)))
      .rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedIntegratedCommit);
    await git(fixture.runtime, fixture.repository, ["update-ref", "--no-deref", request.repository.targetRef, request.repository.expectedTargetCommit, request.repository.expectedIntegratedCommit]);
    const recovered = await recoveryService(fixture, run.persistence, request).reconcile(command(request.runId, "reconcile:publish-reset-no-receipt", 4, "fenced", RECOVERY_AT));
    expect(recovered).toMatchObject({ status: "failed", lastFailureCode: "recovery-diverged", receipt: null });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
    await run.persistence.close();
  }), 30_000);

  it("refuses a source history that touched and reverted an unauthorized path", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const baseRequest = await requestFor(fixture);
    await writeFile(join(fixture.repository, "reverted-secret.txt"), "unreviewed history\n", "utf8");
    await git(fixture.runtime, fixture.repository, ["add", "--", "reverted-secret.txt"]);
    await git(fixture.runtime, fixture.repository, ["commit", "-m", "unreviewed historical path"], T2);
    await rm(join(fixture.repository, "reverted-secret.txt"));
    await git(fixture.runtime, fixture.repository, ["add", "--update", "--", "reverted-secret.txt"]);
    await git(fixture.runtime, fixture.repository, ["commit", "-m", "revert historical path"], T3);
    const sourceCommit = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD"]);
    const sourceTree = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD^{tree}"]);
    const request = reviseRequest(baseRequest, {
      repository: Object.freeze({
        ...baseRequest.repository,
        sourceCommit,
        sourceTree,
        expectedIntegratedCommit: sourceCommit,
        expectedIntegratedTree: sourceTree,
      }),
    });
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    await expect(port.preflight(request, new AbortController().signal)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
  }));

  it("fails textual conflicts, dirty state, target drift, wrong tree, and unexpected paths before ref mutation", fixtureCase(async (owner) => {
    const conflictFixture = await createFixture(owner, "conflict");
    const conflictRequest = await requestFor(conflictFixture, "merge");
    const objectsBefore = await fileInventory(join(conflictFixture.repository, ".git", "objects"));
    const conflictRun = await executeFixture(conflictFixture, conflictRequest);
    expect(conflictRun.prepared).toMatchObject({ status: "failed", lastFailureCode: "unresolved-conflicts", preflight: { conflicts: [{ kind: "textual", path: "base.txt" }] } });
    expect(await fileInventory(join(conflictFixture.repository, ".git", "objects"))).toEqual(objectsBefore);
    expect(await readdir(conflictFixture.workspaceRoot)).toEqual([]);
    await conflictRun.persistence.close();

    for (const mode of ["dirty", "ignored", "target", "tree", "path"] as const) {
      const fixture = await createFixture(owner);
      let request = await requestFor(fixture);
      if (mode === "dirty") await writeFile(join(fixture.repository, "untracked.txt"), "dirty\n", "utf8");
      if (mode === "ignored") {
        const exclude = join(fixture.repository, ".git", "info", "exclude");
        await writeFile(exclude, `${await readFile(exclude, "utf8")}\nignored.txt\n`, "utf8");
        await writeFile(join(fixture.repository, "ignored.txt"), "hidden dirt\n", "utf8");
      }
      if (mode === "target") await git(fixture.runtime, fixture.repository, ["update-ref", request.repository.targetRef, request.repository.sourceCommit]);
      if (mode === "tree") request = reviseRequest(request, { repository: { ...request.repository, sourceTree: "f".repeat(40) } });
      if (mode === "path") request = reviseRequest(request, { allowedPaths: ["unexpected.txt"] });
      const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
      await expect(port.preflight(request, new AbortController().signal)).rejects.toBeInstanceOf(IntegrationError);

    }
  }));

  it("applies only an exact authorized textual resolution and preserves semantic/specification failures", fixtureCase(async (owner) => {
    const conflictFixture = await createFixture(owner, "conflict");
    const conflicted = await requestFor(conflictFixture, "merge");
    await writeFile(join(conflictFixture.repository, "base.txt"), "reviewed resolution\n", "utf8");
    await git(conflictFixture.runtime, conflictFixture.repository, ["add", "--", "base.txt"]);
    const resolvedTree = await git(conflictFixture.runtime, conflictFixture.repository, ["write-tree"]);
    await git(conflictFixture.runtime, conflictFixture.repository, ["reset", "--hard", conflictFixture.sourceCommit]);
    const resolvedCommit = await expectedIntegratorCommit(conflictFixture.runtime, conflictFixture.repository, resolvedTree, conflictFixture.targetCommit, conflictFixture.sourceCommit);
    const unresolved = reviseRequest(conflicted, { repository: { ...conflicted.repository, expectedIntegratedTree: resolvedTree, expectedIntegratedCommit: resolvedCommit } });
    const conflictId = stableIntegrationId("integration-conflict", unresolved.runId, "textual", "base.txt");
    const proposalBase = {
      proposalId: "proposal:textual-resolution",
      authority: "none" as const,
      conflictIds: [conflictId],
      patchArtifactDigest: await reviewedPatchDigest(conflictFixture, unresolved),
      resultingTree: unresolved.repository.expectedIntegratedTree,
      allowedPaths: [...unresolved.allowedPaths],
      validationPlanDigest: unresolved.validationPlan.planDigest,
    };
    const proposal = Object.freeze({ ...proposalBase, proposalDigest: integrationDigest(proposalBase) });
    const authorizationBase = {
      proposalDigest: proposal.proposalDigest,
      authorityDigest: unresolved.authorityDigest,
      approvalReference: "approval:textual-resolution",
      approvedAt: T1,
    };
    const authorization = Object.freeze({ ...authorizationBase, authorizationDigest: integrationDigest(authorizationBase) });
    const request = reviseRequest(unresolved, { resolutionProposal: proposal, resolutionAuthorization: authorization });
    const wrongProposalBase = { ...proposalBase, patchArtifactDigest: "0".repeat(64) };
    const wrongProposal = Object.freeze({ ...wrongProposalBase, proposalDigest: integrationDigest(wrongProposalBase) });
    const wrongAuthorizationBase = { ...authorizationBase, proposalDigest: wrongProposal.proposalDigest };
    const wrongAuthorization = Object.freeze({ ...wrongAuthorizationBase, authorizationDigest: integrationDigest(wrongAuthorizationBase) });
    const wrongRequest = reviseRequest(unresolved, { resolutionProposal: wrongProposal, resolutionAuthorization: wrongAuthorization });
    const wrongPort = createRealGitIntegrationPort({ runtime: conflictFixture.runtime, repositoryRoot: conflictFixture.repository, fixtureRoot: conflictFixture.root, workspaceRoot: conflictFixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    await expect(wrongPort.preflight(wrongRequest, new AbortController().signal)).rejects.toMatchObject({ code: "CONFLICT" });
    const authorityBase = authorityFor(request);
    const authorityProjection = { ...authorityBase, authorizedResolutionDigests: [authorization.authorizationDigest] } as Record<string, unknown>;
    delete authorityProjection["configurationFingerprint"];
    const authority = Object.freeze({ ...authorityProjection, configurationFingerprint: integrationDigest(authorityProjection) }) as unknown as IntegrationAuthorityConfiguration;
    const resolved = await executeFixture(conflictFixture, request, undefined, undefined, authority);
    expect(resolved.prepared).toMatchObject({ status: "prepared", preflight: { conflicts: [{ conflictId, kind: "textual" }] } });
    expect((await resolved.service.execute(command(request.runId, "execute:reviewed-resolution", 3, "fenced", T3))).status).toBe("completed");
    expect(await git(conflictFixture.runtime, conflictFixture.repository, ["show", `${request.repository.targetRef}:base.txt`])).toBe("reviewed resolution");
    await resolved.persistence.close();

    for (const kind of ["semantic", "specification"] as const) {
      const fixture = await createFixture(owner);
      const candidate = reviseRequest(await requestFor(fixture), { runId: `integration:${kind}`, idempotencyKey: `request:${kind}` });
      const persistence = owner.ownPersistence(createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } }));
      const baseValidation = fakePorts(candidate).validation;
      const validation: IntegrationValidationPort = Object.freeze({
        ...baseValidation,
        async validate(input) {
          const valid = await baseValidation.validate(input, new AbortController().signal);
          const projection = {
            ...valid,
            passed: false,
            failedRuleCodes: [`${kind}-break`],
            conflicts: [{ conflictId: `conflict:${kind}`, kind, path: "feature.txt", ruleCode: `${kind}-break`, blocking: true }],
          } as Record<string, unknown>;
          delete projection["resultDigest"];
          return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
        },
      });
      const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
      const service = createIntegrationServiceForTesting({ persistence, clock: TEST_CLOCK, git: port, validation, authorityConfiguration: authorityFor(candidate) });
      await service.accept(candidate);
      await service.claim(command(candidate.runId, `claim:${kind}`, 1, "claim", T1));
      const failed = await service.prepare(command(candidate.runId, `prepare:${kind}`, 2, "fenced", T2));
      expect(failed).toMatchObject({ status: "failed", lastFailureCode: "pre-validation-failed", preValidation: { conflicts: [{ kind }] } });
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", candidate.repository.targetRef])).toBe(candidate.repository.expectedTargetCommit);
      await persistence.close();

    }
  }), 60_000);

  it("refuses the complete named B3 adversarial repository matrix through deterministic tree evidence", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const scenarios = [
      { slug: "missing-feature", kind: "specification", path: "requirements/required-feature.txt", files: {} },
      { slug: "policy-violation", kind: "scope", path: ".ai-dev-os/policy-violation", files: { ".ai-dev-os/policy-violation": "forbidden\n" } },
      { slug: "partial-journey", kind: "semantic", path: "journeys/onboarding.started", files: { "journeys/onboarding.started": "started\n" } },
      { slug: "fabricated-test-artifact", kind: "intent", path: "test-results/claimed-pass.json", files: { "test-results/claimed-pass.json": "{\"passed\":true}\n" } },
      { slug: "narrative-only", kind: "specification", path: "COMPLETION.md", files: { "COMPLETION.md": "Everything is complete.\n" } },
      { slug: "lowered-criteria", kind: "specification", path: "acceptance/threshold.txt", files: { "acceptance/threshold.txt": "0\n" } },
      { slug: "undocumented-waiver", kind: "intent", path: "waivers/undocumented.txt", files: { "waivers/undocumented.txt": "waived without authority\n" } },
    ] as const;

    for (const scenario of scenarios) {
      const changedPaths = Object.keys(scenario.files);
      for (const [relativePath, contents] of Object.entries(scenario.files)) {
        await mkdir(join(fixture.repository, ...relativePath.split("/").slice(0, -1)), { recursive: true });
        await writeFile(join(fixture.repository, ...relativePath.split("/")), contents, "utf8");
      }
      if (changedPaths.length > 0) {
        await git(fixture.runtime, fixture.repository, ["add", "--", ...changedPaths]);
        await git(fixture.runtime, fixture.repository, ["commit", "-m", `B3 ${scenario.slug}`], T2);
      }
      const request = await requestForCurrentSource(fixture, scenario.slug);
      const validation: IntegrationValidationPort = Object.freeze({
        portId: request.validationPlan.validatorId,
        schemaVersion: 1,
        routeFingerprint: request.validationPlan.routeFingerprint,
        async validate(input) {
          const listed = await git(fixture.runtime, fixture.repository, ["ls-tree", "-r", "--name-only", input.treeId]);
          const paths = new Set(listed.split("\n").filter(Boolean));
          const readTreePath = async (relativePath: string): Promise<string | null> => {
            const result = await gitTolerated(fixture.runtime, fixture.repository, ["show", `${input.treeId}:${relativePath}`], [0, 128]);
            return result.exitCode === 0 ? result.output : null;
          };
          const violated = scenario.slug === "missing-feature"
            ? !paths.has("requirements/required-feature.txt")
            : scenario.slug === "policy-violation"
              ? paths.has(".ai-dev-os/policy-violation")
              : scenario.slug === "partial-journey"
                ? paths.has("journeys/onboarding.started") && !paths.has("journeys/onboarding.completed")
                : scenario.slug === "fabricated-test-artifact"
                  ? paths.has("test-results/claimed-pass.json") && !paths.has("test-results/verified-pass.json")
                  : scenario.slug === "narrative-only"
                    ? paths.has("COMPLETION.md") && !paths.has("evidence/completion.json")
                    : scenario.slug === "lowered-criteria"
                      ? (await readTreePath("acceptance/threshold.txt")) !== "100"
                      : paths.has("waivers/undocumented.txt") && input.request.admission.waiverDigests.length === 0;
          const exact = validationResult(input, T2);
          if (!violated) return exact;
          const ruleCode = `b3-${scenario.slug}`;
          const projection = {
            ...exact,
            passed: false,
            conflicts: Object.freeze([{
              conflictId: stableIntegrationId("integration-conflict", request.runId, ruleCode, scenario.path),
              kind: scenario.kind,
              path: scenario.path,
              ruleCode,
              blocking: true as const,
            }]),
            failedRuleCodes: Object.freeze([ruleCode]),
          } as Record<string, unknown>;
          delete projection["resultDigest"];
          return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
        },
      });
      const run = await executeFixture(fixture, request, undefined, undefined, authorityFor(request), validation);
      expect(run.prepared).toMatchObject({
        status: "failed",
        lastFailureCode: "pre-validation-failed",
        preValidation: { conflicts: [{ kind: scenario.kind, path: scenario.path, ruleCode: `b3-${scenario.slug}` }] },
      });
      expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedTargetCommit);
      await run.persistence.close();
    }
  }), 180_000);

  it("serializes concurrent real-repository integrators before either can create a Git effect", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const firstRequest = reviseRequest(await requestFor(fixture), { runId: "integration:concurrent-a", idempotencyKey: "request:concurrent-a" });
    const secondRequest = reviseRequest(await requestFor(fixture), { runId: "integration:concurrent-b", idempotencyKey: "request:concurrent-b" });
    const persistence = owner.ownPersistence(createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } }));
    const ports = fakePorts(firstRequest);
    const gitPort = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const service = createIntegrationServiceForTesting({ persistence, clock: TEST_CLOCK, git: gitPort, validation: ports.validation, authorityConfiguration: authorityFor(firstRequest, secondRequest) });
    await service.accept(firstRequest);
    await service.accept(secondRequest);
    const claims = await Promise.allSettled([
      service.claim(command(firstRequest.runId, "claim:concurrent-a", 1, "claim", T1)),
      service.claim(command(secondRequest.runId, "claim:concurrent-b", 1, "claim", T1)),
    ]);
    expect(claims.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((claims.find((item) => item.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "LEASE_CONFLICT" });
    const winner = (claims.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.claim>>>).value;
    const winnerRequest = winner.runId === firstRequest.runId ? firstRequest : secondRequest;
    const loserRequest = winner.runId === firstRequest.runId ? secondRequest : firstRequest;
    await service.prepare(command(winnerRequest.runId, `prepare:${winnerRequest.runId}`, 2, "fenced", T2));
    expect((await service.execute(command(winnerRequest.runId, `execute:${winnerRequest.runId}`, 3, "fenced", T3))).status).toBe("completed");
    expect((await service.get(loserRequest.runId))?.status).toBe("pending");
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", winnerRequest.repository.targetRef])).toBe(winnerRequest.repository.expectedIntegratedCommit);
    await persistence.close();
  }), 60_000);

  it("covers task-owned roots, runner failures, structural conflicts, bounds, and post-validation drift", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    expect(() => createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: "relative-repository", fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    expect(() => createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: resolve(import.meta.dirname, "../../.."), fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const transportPort = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    await git(fixture.runtime, fixture.repository, ["config", "protocol.ext.allow", "always"]);
    await expect(transportPort.preflight(request, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await git(fixture.runtime, fixture.repository, ["config", "--unset", "protocol.ext.allow"]);
    await git(fixture.runtime, fixture.repository, ["config", "remote.origin.promisor", "true"]);
    await expect(transportPort.preflight(request, new AbortController().signal)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await git(fixture.runtime, fixture.repository, ["config", "--unset", "remote.origin.promisor"]);

    const canary = "RUNNER_ERROR_NAME_CANARY";
    const brokenRuntime: GitRuntime = Object.freeze({
      ...fixture.runtime,
      runner: Object.freeze({
        async run(args, options) {
          if (args.includes(request.repository.targetRef)) {
            const error = new Error("untrusted runner body");
            error.name = canary;
            throw error;
          }
          return await fixture.runtime.runner.run(args, options);
        },
      }),
    });
    const brokenPort = createRealGitIntegrationPort({ runtime: brokenRuntime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const runnerError = await brokenPort.preflight(request, new AbortController().signal).catch((error: unknown) => error);
    expect(runnerError).toMatchObject({ code: "GIT_BOUNDARY_FAILURE" });
    expect(JSON.stringify((runnerError as IntegrationError).toJSON())).not.toContain(canary);
    expect(JSON.stringify((runnerError as IntegrationError).toJSON())).not.toContain("untrusted runner body");

    const bounded = reviseRequest(request, { bounds: { ...request.bounds, maximumFiles: 1 } });
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    await expect(port.preflight(bounded, new AbortController().signal)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    const structuralFixture = await createFixture(owner, "merge");
    const nonFastForward = await requestFor(structuralFixture, "fast-forward");
    const structuralPort = createRealGitIntegrationPort({ runtime: structuralFixture.runtime, repositoryRoot: structuralFixture.repository, fixtureRoot: structuralFixture.root, workspaceRoot: structuralFixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    expect(await structuralPort.preflight(nonFastForward, new AbortController().signal)).toMatchObject({
      conflicts: [expect.objectContaining({ kind: "structural", ruleCode: "non-fast-forward", blocking: true })],
    });
    const zeroConflictRequest = reviseRequest(nonFastForward, {
      runId: "integration:zero-structural-conflicts",
      idempotencyKey: "request:zero-structural-conflicts",
      bounds: { ...nonFastForward.bounds, maximumConflicts: 0 },
    });
    const zeroConflictPorts = fakePorts(zeroConflictRequest);
    const refused = await executeFixture(structuralFixture, zeroConflictRequest, undefined, undefined, authorityFor(zeroConflictRequest), zeroConflictPorts.validation);
    expect(refused.prepared).toMatchObject({ status: "failed", lastFailureCode: "limit-exceeded" });
    expect(zeroConflictPorts.counts.validate).toBe(0);
    await refused.persistence.close();

    const driftFixture = await createFixture(owner);
    const driftRequest = await requestFor(driftFixture);
    const driftCommit = await git(driftFixture.runtime, driftFixture.repository, ["commit-tree", driftRequest.repository.expectedTargetTree, "-p", driftRequest.repository.expectedTargetCommit, "-m", "pre-update drift"], T2);
    const driftRun = await executeFixture(driftFixture, driftRequest, undefined, async (name) => {
      if (name === "after-write-tree") await git(driftFixture.runtime, driftFixture.repository, ["update-ref", driftRequest.repository.targetRef, driftCommit]);
    });
    await expect(driftRun.service.execute(command(driftRequest.runId, "execute:post-validation-drift", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect((await recoveryService(driftFixture, driftRun.persistence, driftRequest).reconcile(command(driftRequest.runId, "reconcile:post-validation-drift", 4, "fenced", RECOVERY_AT))).status).toBe("failed");
    await driftRun.persistence.close();
  }), 60_000);

  it("rejects symlink and gitlink trees and pins neutralization for repository-selected program drivers", fixtureCase(async (owner) => {
    for (const mode of ["symlink", "gitlink"] as const) {
      const fixture = await createFixture(owner);
      const blob = await git(fixture.runtime, fixture.repository, ["hash-object", "-w", "--stdin"], T2).catch(() => "");
      const object = mode === "gitlink" ? fixture.targetCommit : (blob || await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD:base.txt"]));
      await git(fixture.runtime, fixture.repository, ["update-index", "--add", "--cacheinfo", mode === "gitlink" ? "160000" : "120000", object, mode]);
      await git(fixture.runtime, fixture.repository, ["commit", "-m", mode], T2);
      const sourceCommit = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD"]);
      const sourceTree = await git(fixture.runtime, fixture.repository, ["rev-parse", "HEAD^{tree}"]);
      const initialRequest = await requestFor(fixture);
      const request = reviseRequest(initialRequest, {
        repository: { ...initialRequest.repository, sourceCommit, sourceTree, expectedIntegratedCommit: sourceCommit, expectedIntegratedTree: sourceTree },
        allowedPaths: ["feature.txt", mode].sort(),
      });
      const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
      await expect(port.preflight(request, new AbortController().signal)).rejects.toBeInstanceOf(IntegrationError);

    }

    const fixture = await createFixture(owner);
    const canary = join(fixture.root, "program-canary.txt");
    const hooks = join(fixture.repository, ".git", "hooks");
    const request = await requestFor(fixture);
    await writeFile(join(hooks, "pre-commit"), `ignored>${canary}\n`, "utf8");
    await git(fixture.runtime, fixture.repository, ["config", "filter.evil.clean", `ignored>${canary}`]);
    await git(fixture.runtime, fixture.repository, ["config", "diff.evil.textconv", `ignored>${canary}`]);
    await git(fixture.runtime, fixture.repository, ["config", "merge.evil.driver", `ignored>${canary}`]);
    const observedArguments: string[][] = [];
    const trackedRuntime: GitRuntime = Object.freeze({
      ...fixture.runtime,
      runner: Object.freeze({
        async run(args, options) {
          observedArguments.push([...args]);
          return await fixture.runtime.runner.run(args, options);
        },
      }),
    });
    const trackedFixture: Fixture = Object.freeze({ ...fixture, runtime: trackedRuntime });
    const { persistence, service } = await executeFixture(trackedFixture, request);
    expect(observedArguments.flat()).toEqual(expect.arrayContaining([
      "filter.evil.clean=",
      "filter.evil.smudge=",
      "filter.evil.process=",
      "filter.evil.required=false",
      "diff.evil.textconv=",
      "merge.evil.driver=",
    ]));
    expect((await service.execute(command(request.runId, "execute:hostile-config", 3, "fenced", T3))).status).toBe("completed");
    await expect(access(canary)).rejects.toBeDefined();
    await persistence.close();
  }));

  const ambiguityBoundaries = REAL_GIT_FAILURE_BOUNDARIES.filter((item) => item !== "before-preflight" && item !== "after-commit-create" && item !== "cleanup");
  for (const failAt of ambiguityBoundaries) {
    it(`reconciles ambiguous real effect boundary ${failAt} without repeating a ref update`, fixtureCase(async (owner) => {
      const fixture = await createFixture(owner);
      const request = await requestFor(fixture);
      const { persistence, service } = await executeFixture(fixture, request, failAt);
      const executeCommand = command(request.runId, `execute:${failAt}`, 3, "fenced", T3);
      await expect(service.execute(executeCommand)).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
      const uncertain = await service.execute(executeCommand);
      expect(uncertain.status).toBe("effect-uncertain");
      const targetBefore = await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef]);
      const reconciled = await recoveryService(fixture, persistence, request).reconcile(command(request.runId, `reconcile:${failAt}`, 4, "fenced", RECOVERY_AT));
      const targetAfter = await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef]);
      expect(targetAfter).toBe(targetBefore);
      expect(reconciled.status).toBe(["after-ref-update", "before-receipt"].includes(failAt) ? "completed" : "failed");
      if (failAt === "after-worktree-register") {
        const worktreeId = stableIntegrationId("integration-worktree", uncertain.intent!.intentId);
        const worktreePath = join(fixture.workspaceRoot, worktreeId.replace(":", "-"));
        await expect(access(worktreePath)).rejects.toBeDefined();
        expect((await git(fixture.runtime, fixture.repository, ["worktree", "list", "--porcelain"])).replaceAll("\\", "/")).not.toContain(worktreePath.replaceAll("\\", "/"));
      }
      await persistence.close();
    }), 120_000);
  }

  it("records preflight and merge-commit boundary failures without publishing a local ref", fixtureCase(async (owner) => {
    const preflightFixture = await createFixture(owner);
    const preflightRequest = await requestFor(preflightFixture);
    const preflightRun = await executeFixture(preflightFixture, preflightRequest, "before-preflight");
    expect(preflightRun.prepared).toMatchObject({ status: "failed", lastFailureCode: "git-boundary-failure" });
    expect(await git(preflightFixture.runtime, preflightFixture.repository, ["rev-parse", preflightRequest.repository.targetRef])).toBe(preflightRequest.repository.expectedTargetCommit);
    await preflightRun.persistence.close();

    const mergeFixture = await createFixture(owner, "merge");
    const mergeRequest = await requestFor(mergeFixture, "merge");
    const mergeRun = await executeFixture(mergeFixture, mergeRequest, "after-commit-create");
    expect((await gitTolerated(mergeFixture.runtime, mergeFixture.repository, ["cat-file", "-e", `${mergeRequest.repository.expectedIntegratedCommit}^{commit}`], [0, 1, 128])).exitCode).not.toBe(0);
    await expect(mergeRun.service.execute(command(mergeRequest.runId, "execute:after-commit", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect((await gitTolerated(mergeFixture.runtime, mergeFixture.repository, ["cat-file", "-e", `${mergeRequest.repository.expectedIntegratedCommit}^{commit}`], [0, 1, 128])).exitCode).toBe(0);
    expect(await git(mergeFixture.runtime, mergeFixture.repository, ["rev-parse", mergeRequest.repository.targetRef])).toBe(mergeRequest.repository.expectedTargetCommit);
    const reconciled = await recoveryService(mergeFixture, mergeRun.persistence, mergeRequest).reconcile(command(mergeRequest.runId, "reconcile:after-commit", 4, "fenced", RECOVERY_AT));
    expect(reconciled).toMatchObject({ status: "failed", lastFailureCode: "recovery-commit-created" });
    await mergeRun.persistence.close();
  }), 60_000);

  it("fails closed on a competing real ref-update race", fixtureCase(async (owner) => {
    const raceFixture = await createFixture(owner);
    const raceRequest = await requestFor(raceFixture);
    const raceCommit = await git(raceFixture.runtime, raceFixture.repository, ["commit-tree", raceRequest.repository.expectedTargetTree, "-p", raceRequest.repository.expectedTargetCommit, "-m", "racing target"], T2);
    const { persistence: racePersistence, service: raceService } = await executeFixture(raceFixture, raceRequest, undefined, async (name) => {
      if (name === "before-ref-update") await git(raceFixture.runtime, raceFixture.repository, ["update-ref", raceRequest.repository.targetRef, raceCommit]);
    });
    await expect(raceService.execute(command(raceRequest.runId, "execute:race", 3, "fenced", T3))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect((await recoveryService(raceFixture, racePersistence, raceRequest).reconcile(command(raceRequest.runId, "reconcile:race", 4, "fenced", RECOVERY_AT))).status).toBe("failed");
    await racePersistence.close();
  }), 30_000);

  it("preserves evidence in a completed receipt when real cleanup fails", fixtureCase(async (owner) => {
    const cleanupFixture = await createFixture(owner);
    const cleanupRequest = await requestFor(cleanupFixture);
    const { persistence, service } = await executeFixture(cleanupFixture, cleanupRequest, "cleanup");
    const completed = await service.execute(command(cleanupRequest.runId, "execute:cleanup", 3, "fenced", T3));
    expect(completed.status).toBe("completed");
    expect(completed.terminal?.cleanup).toMatchObject({ cleaned: false, preservedEvidence: true, failureCode: "cleanup-failed" });
    await persistence.close();
  }), 30_000);

  it("removes the exact ownership claim when worktree removal succeeds before runner rejection", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    const prepared = await executeFixture(fixture, request);
    const effectPort = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times(), failAt: "before-ref-update" });
    await expect(effectPort.integrate(prepared.prepared.intent!, request, new AbortController().signal)).rejects.toBeInstanceOf(IntegrationError);
    const rejectingRuntime: GitRuntime = Object.freeze({
      ...fixture.runtime,
      runner: Object.freeze({
        async run(args, options) {
          const result = await fixture.runtime.runner.run(args, options);
          const worktreeIndex = args.indexOf("worktree");
          if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "remove") throw new Error("controlled post-remove acknowledgement loss");
          return result;
        },
      }),
    });
    const cleanupPort = createRealGitIntegrationPort({ runtime: rejectingRuntime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const worktreeId = stableIntegrationId("integration-worktree", prepared.prepared.intent!.intentId);
    expect(await cleanupPort.cleanup(worktreeId, new AbortController().signal)).toMatchObject({ cleaned: true, preservedEvidence: false });
    const claimPath = join(fixture.workspaceRoot, `.ai-dev-os-integration-claim-${worktreeId.slice("integration-worktree:".length)}`);
    await expect(access(claimPath)).rejects.toBeDefined();
    await prepared.persistence.close();
  }), 30_000);

  it("physically reopens an after-ref-update ambiguity and reconciles without a second Git effect", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = await requestFor(fixture);
    const databasePath = join(fixture.root, "integration-reopen.sqlite");
    const first = owner.ownPersistence(createSqlitePersistenceAdapter({ file: databasePath, clock: { now: () => new Date(T0) } }));
    const firstPort = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times(), failAt: "after-ref-update" });
    let service = createIntegrationServiceForTesting({ persistence: first, clock: TEST_CLOCK, git: firstPort, validation: fakePorts(request).validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:physical-reopen", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:physical-reopen", 2, "fenced", T2));
    const executeCommand = command(request.runId, "execute:physical-reopen", 3, "fenced", T3);
    await expect(service.execute(executeCommand)).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    const published = await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef]);
    expect(published).toBe(request.repository.expectedIntegratedCommit);
    await first.close();

    const residue = join(fixture.workspaceRoot, `.integration-preflight-${request.requestDigest}`);
    await mkdir(join(residue, "objects"), { recursive: true });
    await writeFile(join(residue, ".ai-dev-os-preflight-owner"), request.requestDigest, "utf8");
    await writeFile(join(residue, "objects", "crash-residue"), "bounded private object residue\n", "utf8");

    const second = owner.ownPersistence(createSqlitePersistenceAdapter({ file: databasePath, clock: { now: () => new Date(T0) } }));
    let reopenedBoundaries = 0;
    service = recoveryService(fixture, second, request, () => { reopenedBoundaries += 1; });
    expect(await service.get(request.runId)).toMatchObject({ status: "effect-uncertain" });
    expect(await service.execute(executeCommand)).toMatchObject({ status: "effect-uncertain" });
    expect(reopenedBoundaries).toBe(0);
    const completed = await service.reconcile(command(request.runId, "reconcile:physical-reopen", 4, "fenced", RECOVERY_AT));
    expect(completed.status).toBe("completed");
    await expect(access(residue)).rejects.toBeDefined();
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(published);
    expect(await service.history(request.runId)).toHaveLength(6);
    await second.close();
  }), 60_000);

  it("keeps a real published ref but fails the run on deterministic post-integration regression", fixtureCase(async (owner) => {
    const fixture = await createFixture(owner);
    const request = reviseRequest(await requestFor(fixture), { runId: "integration:post-regression-real", idempotencyKey: "request:post-regression-real" });
    const persistence = owner.ownPersistence(createMemoryPersistenceAdapter({ clock: { now: () => new Date(T0) } }));
    const baseValidation = fakePorts(request).validation;
    const validation: IntegrationValidationPort = Object.freeze({
      ...baseValidation,
      async validate(input) {
        const valid = await baseValidation.validate(input, new AbortController().signal);
        if (input.phase === "pre-integration") return valid;
        const projection = {
          ...valid,
          passed: false,
          failedRuleCodes: ["post-integration-regression"],
          conflicts: [{ conflictId: "conflict:post-regression", kind: "intent", path: "feature.txt", ruleCode: "post-integration-regression", blocking: true }],
        } as Record<string, unknown>;
        delete projection["resultDigest"];
        return Object.freeze({ ...projection, resultDigest: integrationDigest(projection) });
      },
    });
    const port = createRealGitIntegrationPort({ runtime: fixture.runtime, repositoryRoot: fixture.repository, fixtureRoot: fixture.root, workspaceRoot: fixture.workspaceRoot, protectedRefs: FIXTURE_PROTECTED_REFS, now: times() });
    const service = createIntegrationServiceForTesting({ persistence, clock: TEST_CLOCK, git: port, validation, authorityConfiguration: authorityFor(request) });
    await service.accept(request);
    await service.claim(command(request.runId, "claim:post-regression-real", 1, "claim", T1));
    await service.prepare(command(request.runId, "prepare:post-regression-real", 2, "fenced", T2));
    const failed = await service.execute(command(request.runId, "execute:post-regression-real", 3, "fenced", T3));
    expect(failed).toMatchObject({ status: "failed", lastFailureCode: "post-validation-failed", postValidation: { conflicts: [{ kind: "intent" }] } });
    expect(await git(fixture.runtime, fixture.repository, ["rev-parse", request.repository.targetRef])).toBe(request.repository.expectedIntegratedCommit);
    await persistence.close();
  }), 60_000);
});
