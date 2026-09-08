import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  adoptExistingControlService,
  createControlArtifactStore,
  type AdoptedControlService,
} from "@ai-dev-os/control-service";
import { SERVICE_READY_DEADLINE_MS, SERVICE_SHUTDOWN_DEADLINE_MS } from "../main/constants.js";
import type { PresentationMode, ServiceObservation } from "../shared/contracts.js";
import { exactPlanningRecord, parseNativePlanningRequest, parsePlanningQuery, type NativePlanningReply, type NativePlanningRequest, type PlanningQuery, type PlanningReply } from "../shared/planning-ipc.js";
import { canonicalServicePath } from "./storage-paths.js";

export type OwnedServicePhase = "loading" | "ready" | "service-lost" | "failed-start" | "read-only" | "stopped";

export interface OwnedServiceSnapshot {
  readonly phase: OwnedServicePhase;
  readonly presentationMode: PresentationMode;
  readonly attemptStartedAt: string;
  readonly recoveryAvailable: boolean;
  readonly observation: ServiceObservation | null;
  readonly failureCode: "SERVICE_START_FAILED" | "SERVICE_READY_TIMEOUT" | "SERVICE_LOST" | null;
}

interface ActiveLaunch {
  readonly child: ChildProcess;
  readonly root: string;
  readonly nonce: string;
  expectedStop: boolean;
  verified: boolean;
}

export interface OwnedServiceController {
  start(mode?: PresentationMode): Promise<void>;
  retry(): Promise<void>;
  openReadOnly(): void;
  snapshot(): OwnedServiceSnapshot;
  stop(): Promise<void>;
  terminateOwnedChildForTest(): Promise<void>;
  ownedProcessIdForTest(): number | null;
  ownedRuntimeRootForTest(): string | null;
  planning(query: PlanningQuery): Promise<PlanningReply>;
  loseNextPlanningReplyForTest(): void;
}

export interface OwnedServiceControllerOptions {
  readonly childPath: string;
  readonly execPath: string;
  readonly dataRoot: string;
  readonly storageParent: string;
  readonly initialMode: PresentationMode;
  readonly onChange?: () => void;
  readonly clock?: () => Date;
  readonly serviceReadyDeadlineMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly nativePlanning?: (request: NativePlanningRequest) => Promise<NativePlanningReply>;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"] as const;
  const output: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function parseReadyMessage(value: unknown, expectedNonce: string): "ready" | "failed" | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record["launchNonce"] !== expectedNonce) return null;
  if (keys === "kind,launchNonce" && record["kind"] === "ready") return "ready";
  if (keys === "code,kind,launchNonce" && record["kind"] === "failed" && record["code"] === "SERVICE_START_FAILED") return "failed";
  return null;
}

export function acceptsChildReadyMessage(value: unknown, expectedNonce: string): boolean {
  return parseReadyMessage(value, expectedNonce) === "ready";
}

export function sanitizeAdoptedService(
  adopted: AdoptedControlService,
  observedAt: string,
): ServiceObservation {
  return Object.freeze({
    freshness: "live",
    observedAt,
    ageMs: 0,
    serviceVersion: adopted.descriptor.serviceVersion,
    presentationMode: adopted.presentationMode,
    runningSessions: adopted.runningSessions,
    verification: "identity-verified-connection-closed",
    dataSource: "owned-synthetic-development-service",
    authority: "none",
    commands: Object.freeze([]) as readonly [],
  });
}

function withAge(observation: ServiceObservation, now: Date, freshness: "live" | "stale"): ServiceObservation {
  return Object.freeze({
    ...observation,
    freshness,
    ageMs: Math.max(0, now.valueOf() - new Date(observation.observedAt).valueOf()),
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export function createOwnedServiceController(options: OwnedServiceControllerOptions): OwnedServiceController {
  const childPath = resolve(options.childPath);
  let storageParent = resolve(options.storageParent);
  let dataRoot = resolve(options.dataRoot);
  const samePath = (left: string, right: string): boolean => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  const contains = (root: string, target: string): boolean => { const part = relative(process.platform === "win32" ? root.toLowerCase() : root, process.platform === "win32" ? target.toLowerCase() : target); return part === "" || part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part); };
  if (contains(storageParent, dataRoot) || contains(dataRoot, storageParent)) throw new Error("SERVICE_DURABLE_ROOT_OVERLAP");
  const storagePrefix = "owned-service-";
  const clock = options.clock ?? (() => new Date());
  const readyDeadlineMs = options.serviceReadyDeadlineMs ?? SERVICE_READY_DEADLINE_MS;
  const shutdownDeadlineMs = options.shutdownDeadlineMs ?? SERVICE_SHUTDOWN_DEADLINE_MS;
  if (!Number.isSafeInteger(readyDeadlineMs) || readyDeadlineMs < 10 || readyDeadlineMs > SERVICE_READY_DEADLINE_MS) throw new Error("SERVICE_READY_DEADLINE_INVALID");
  if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 10 || shutdownDeadlineMs > SERVICE_SHUTDOWN_DEADLINE_MS) throw new Error("SERVICE_SHUTDOWN_DEADLINE_INVALID");

  let mode = options.initialMode;
  let phase: OwnedServicePhase = "loading";
  let attemptStartedAt = clock().toISOString();
  let recoveryAt = Number.POSITIVE_INFINITY;
  let failureCode: OwnedServiceSnapshot["failureCode"] = null;
  let lastObservation: ServiceObservation | null = null;
  let active: ActiveLaunch | null = null;
  let recoveryTimer: NodeJS.Timeout | null = null;
  let operation: Promise<void> = Promise.resolve();
  const pendingRootCleanup = new Set<Promise<void>>();
  const ownedRoots = new Map<string, Readonly<{ dev: bigint; ino: bigint }>>();
  const removedRoots = new Set<string>();
  let rootCleanupFailed = false;
  const planningPending = new Map<string, { launch: ActiveLaunch; query: PlanningQuery; finish: (value: PlanningReply | null) => void }>();
  const nativePending = new Set<string>();
  let loseNextPlanningReply = false;
  function failPlanning(launch: ActiveLaunch): void { for (const pending of [...planningPending.values()]) if (pending.launch === launch) pending.finish(null); }
  async function planningMessage(launch: ActiveLaunch, message: unknown): Promise<void> {
    if (active !== launch || !launch.verified || launch.expectedStop || message === null || typeof message !== "object" || Array.isArray(message)) return;
    const raw = message as Record<string, unknown>;
    if (raw["launchNonce"] !== launch.nonce) return;
    try {
      if (raw["kind"] === "planning-reply") {
        const r = exactPlanningRecord(raw, ["kind", "launchNonce", "requestId", "ok", "value"]), pending = planningPending.get(String(r["requestId"]));
        if (pending?.launch !== launch) return;
        if (loseNextPlanningReply && pending.query.kind === "command") { loseNextPlanningReply = false; pending.finish(null); return; }
        pending.finish(r["ok"] === true && JSON.stringify(r["value"]).length <= 2_097_152 ? r["value"] as PlanningReply : null);
      } else if (raw["kind"] === "planning-native") {
        const r = exactPlanningRecord(raw, ["kind", "launchNonce", "requestId", "nativeId", "request"]), pending = planningPending.get(String(r["requestId"]));
        if (pending?.launch !== launch || pending.query.kind !== "command" || typeof r["nativeId"] !== "string" || !/^[a-f0-9]{32}$/u.test(r["nativeId"]) || nativePending.has(r["nativeId"]) || nativePending.size >= 8) return;
        const request = parseNativePlanningRequest(r["request"]), nativeId = r["nativeId"]; nativePending.add(nativeId);
        try {
          const value = await options.nativePlanning?.(request) ?? null;
          if (active === launch && !launch.expectedStop && planningPending.get(String(r["requestId"])) === pending && launch.child.connected) launch.child.send({ kind: "planning-native-reply", launchNonce: launch.nonce, nativeId, value });
        } finally { nativePending.delete(nativeId); }
      }
    } catch { /* Malformed private child traffic cannot acquire host authority. */ }
  }

  const notify = (): void => { options.onChange?.(); };

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const scheduleRecovery = (): void => {
    clearRecoveryTimer();
    const remaining = Math.max(0, recoveryAt - clock().valueOf());
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      notify();
    }, remaining);
  };

  const removeRoot = async (root: string): Promise<void> => {
    const resolvedRoot = resolve(root);
    if (removedRoots.has(resolvedRoot)) return;
    const expected = ownedRoots.get(resolvedRoot);
    if (expected === undefined || !samePath(dirname(resolvedRoot), storageParent) || !basename(resolvedRoot).startsWith(storagePrefix)) {
      throw new Error("SERVICE_ROOT_OWNERSHIP_REFUSED");
    }
    if (!samePath(await canonicalServicePath(resolvedRoot), resolvedRoot)) throw new Error("SERVICE_ROOT_OWNERSHIP_REFUSED");
    let current;
    try { current = await lstat(resolvedRoot, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { ownedRoots.delete(resolvedRoot); removedRoots.add(resolvedRoot); return; } throw error; }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("SERVICE_ROOT_OWNERSHIP_REFUSED");
    await rm(resolvedRoot, { recursive: true, force: true });
    ownedRoots.delete(resolvedRoot);
    removedRoots.add(resolvedRoot);
  };

  const trackRootCleanup = (root: string): void => {
    const cleanup = removeRoot(root).catch(() => {
      rootCleanupFailed = true;
    });
    pendingRootCleanup.add(cleanup);
    void cleanup.finally(() => pendingRootCleanup.delete(cleanup));
  };

  const finishPendingRootCleanup = async (): Promise<void> => {
    await Promise.all([...pendingRootCleanup]);
    if (rootCleanupFailed) throw new Error("SERVICE_ROOT_CLEANUP_FAILED");
  };

  const closeLaunch = async (launch: ActiveLaunch): Promise<void> => {
    launch.expectedStop = true;
    failPlanning(launch);
    if (launch.child.exitCode === null && launch.child.signalCode === null) {
      launch.child.send?.(Object.freeze({ kind: "shutdown", launchNonce: launch.nonce }));
      if (!(await waitForExit(launch.child, shutdownDeadlineMs))) {
        launch.child.kill();
        if (!(await waitForExit(launch.child, shutdownDeadlineMs))) {
          throw new Error("SERVICE_CHILD_SHUTDOWN_TIMEOUT");
        }
      }
    }
    try {
      await removeRoot(launch.root);
    } finally {
      if (active === launch) active = null;
    }
  };

  const markFailed = (code: "SERVICE_START_FAILED" | "SERVICE_READY_TIMEOUT", deadlineAt: number): void => {
    phase = "failed-start";
    failureCode = code;
    recoveryAt = deadlineAt;
    scheduleRecovery();
    notify();
  };

  const startOnce = async (requestedMode: PresentationMode): Promise<void> => {
    clearRecoveryTimer();
    if (active !== null) await closeLaunch(active);
    await finishPendingRootCleanup();
    removedRoots.clear();
    mode = requestedMode;
    phase = "loading";
    failureCode = null;
    attemptStartedAt = clock().toISOString();
    const deadlineAt = new Date(attemptStartedAt).valueOf() + readyDeadlineMs;
    recoveryAt = Number.POSITIVE_INFINITY;
    notify();
    let deadlineElapsed = false;
    const deadlineNotificationTimer = setTimeout(() => {
      deadlineElapsed = true;
      if (phase === "loading") markFailed("SERVICE_READY_TIMEOUT", deadlineAt);
    }, Math.max(0, deadlineAt - clock().valueOf()));
    let root: string | null = null;
    try {
      // The runner and native Windows paths can contain 8.3 aliases. Normalize
      // only after refusing links, then recheck the durable/transport separation.
      const nextStorageParent = await canonicalServicePath(storageParent);
      const nextDataRoot = await canonicalServicePath(dataRoot);
      if (contains(nextStorageParent, nextDataRoot) || contains(nextDataRoot, nextStorageParent)) throw new Error("SERVICE_DURABLE_ROOT_OVERLAP");
      storageParent = nextStorageParent;
      dataRoot = nextDataRoot;
      if (deadlineElapsed || clock().valueOf() >= deadlineAt) throw new Error("SERVICE_READY_TIMEOUT");
      await mkdir(storageParent, { recursive: true });
      if (!samePath(await canonicalServicePath(storageParent), storageParent)) throw new Error("SERVICE_STORAGE_UNSAFE");
      if (deadlineElapsed || clock().valueOf() >= deadlineAt) throw new Error("SERVICE_READY_TIMEOUT");
      root = await mkdtemp(join(storageParent, storagePrefix));
      const created = await lstat(root, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("SERVICE_ROOT_OWNERSHIP_REFUSED");
      ownedRoots.set(root, { dev: created.dev, ino: created.ino });
      if (deadlineElapsed || clock().valueOf() >= deadlineAt) throw new Error("SERVICE_READY_TIMEOUT");
    } catch (error) {
      clearTimeout(deadlineNotificationTimer);
      if (root !== null) {
        try { await removeRoot(root); }
        catch { rootCleanupFailed = true; }
      }
      if (!deadlineElapsed) {
        markFailed(error instanceof Error && error.message === "SERVICE_READY_TIMEOUT" ? "SERVICE_READY_TIMEOUT" : "SERVICE_START_FAILED", deadlineAt);
      }
      throw error;
    }
    const nonce = randomBytes(16).toString("hex");
    const child = fork(childPath, [], {
      cwd: dirname(childPath),
      env: childEnvironment(),
      execPath: resolve(options.execPath),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const launch: ActiveLaunch = { child, root, nonce, expectedStop: false, verified: false };
    active = launch;

    child.once("exit", () => {
      failPlanning(launch);
      if (active !== launch || launch.expectedStop) return;
      active = null;
      trackRootCleanup(root);
      phase = launch.verified ? "service-lost" : "failed-start";
      failureCode = launch.verified ? "SERVICE_LOST" : "SERVICE_START_FAILED";
      if (phase === "failed-start") {
        recoveryAt = deadlineAt;
        scheduleRecovery();
      }
      notify();
    });
    child.on("message", (message: unknown) => { void planningMessage(launch, message); });

    const readiness = new Promise<"ready" | "failed">((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.on("message", (message: unknown) => {
        const parsed = parseReadyMessage(message, nonce);
        if (parsed !== null) resolveReady(parsed);
      });
      child.once("exit", () => rejectReady(new Error("SERVICE_CHILD_EXITED")));
      child.send(Object.freeze({ kind: "start", launchNonce: nonce, storageRoot: root, dataRoot, presentationMode: requestedMode }));
    });
    let timer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        readiness,
        new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), Math.max(0, deadlineAt - clock().valueOf()));
        }),
      ]);
      if (result === "timeout") throw new Error("SERVICE_READY_TIMEOUT");
      if (result === "failed") throw new Error("SERVICE_START_FAILED");
      const adoptionRemainingMs = deadlineAt - clock().valueOf();
      if (adoptionRemainingMs <= 0) throw new Error("SERVICE_READY_TIMEOUT");
      const adopted = await adoptExistingControlService({
        store: createControlArtifactStore({ root }),
        expectedPresentationMode: requestedMode,
        timeoutMs: Math.min(5_000, adoptionRemainingMs),
      });
      if (clock().valueOf() >= deadlineAt) throw new Error("SERVICE_READY_TIMEOUT");
      if (active !== launch || child.exitCode !== null || child.signalCode !== null) throw new Error("SERVICE_CHILD_EXITED");
      lastObservation = sanitizeAdoptedService(adopted, clock().toISOString());
      launch.verified = true;
      phase = "ready";
      failureCode = null;
      notify();
    } catch (error) {
      const code = error instanceof Error && error.message === "SERVICE_READY_TIMEOUT" ? "SERVICE_READY_TIMEOUT" : "SERVICE_START_FAILED";
      markFailed(code, deadlineAt);
      try {
        await closeLaunch(launch);
      } catch {
        rootCleanupFailed = true;
      }
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      clearTimeout(deadlineNotificationTimer);
    }
  };

  const serialize = (action: () => Promise<void>): Promise<void> => {
    const next = operation.then(action, action);
    operation = next.catch(() => undefined);
    return next;
  };

  return Object.freeze({
    loseNextPlanningReplyForTest() { if (phase !== "ready") throw new Error("ACTION_UNAVAILABLE"); loseNextPlanningReply = true; },
    async planning(value: PlanningQuery): Promise<PlanningReply> {
      const query = parsePlanningQuery(value), launch = active;
      if (phase !== "ready" || launch === null || !launch.verified || launch.expectedStop || planningPending.size >= 8) throw new Error("SERVICE_UNAVAILABLE");
      const requestId = randomBytes(16).toString("hex");
      return await new Promise<PlanningReply>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => finish(null), query.kind === "command" ? 120_000 : 20_000);
        const finish = (reply: PlanningReply | null): void => {
          if (!planningPending.has(requestId)) return;
          clearTimeout(timer); planningPending.delete(requestId);
          if (reply === null) rejectReply(new Error("SERVICE_PLANNING_UNCONFIRMED")); else resolveReply(reply);
        };
        planningPending.set(requestId, { launch, query, finish });
        launch.child.send({ kind: "planning-request", launchNonce: launch.nonce, requestId, query }, (error) => { if (error !== null) finish(null); });
      });
    },
    async start(requestedMode = mode) {
      await serialize(async () => { await startOnce(requestedMode); });
    },
    async retry() {
      const recoveryAvailable = clock().valueOf() >= recoveryAt;
      if (!(phase === "service-lost" || phase === "read-only" || (phase === "failed-start" && recoveryAvailable))) {
        throw new Error("ACTION_UNAVAILABLE");
      }
      await serialize(async () => { await startOnce(mode); });
    },
    openReadOnly() {
      if ((phase !== "service-lost" && phase !== "failed-start") || lastObservation === null) throw new Error("ACTION_UNAVAILABLE");
      if (phase === "failed-start" && clock().valueOf() < recoveryAt) throw new Error("ACTION_UNAVAILABLE");
      phase = "read-only";
      notify();
    },
    snapshot() {
      const now = clock();
      const observation = lastObservation === null
        ? null
        : withAge(lastObservation, now, phase === "ready" ? "live" : "stale");
      return Object.freeze({
        phase,
        presentationMode: mode,
        attemptStartedAt,
        recoveryAvailable: phase !== "failed-start" || now.valueOf() >= recoveryAt,
        observation,
        failureCode,
      });
    },
    async stop() {
      clearRecoveryTimer();
      await serialize(async () => {
        if (active !== null) await closeLaunch(active);
        await finishPendingRootCleanup();
        phase = "stopped";
        notify();
      });
    },
    async terminateOwnedChildForTest() {
      const launch = active;
      if (launch === null) throw new Error("ACTION_UNAVAILABLE");
      launch.child.send?.(Object.freeze({ kind: "terminate-for-test", launchNonce: launch.nonce }));
      if (!(await waitForExit(launch.child, shutdownDeadlineMs))) throw new Error("SERVICE_TEST_TERMINATION_TIMEOUT");
    },
    ownedProcessIdForTest: () => active?.child.pid ?? null,
    ownedRuntimeRootForTest: () => active?.root ?? null,
  });
}
