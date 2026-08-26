import { createControlArtifactStore, type ControlArtifactStore } from "../src/artifacts.js";
import { startControlServiceInternal, type ControlServiceHandle } from "../src/listener.js";
import type { RandomBytesPort } from "../src/identity.js";
import type { ProcessLivenessPort } from "../src/single-instance.js";
import type { ControlPresentationMode } from "../src/routes.js";

export interface ControlServiceTestingOptions {
  readonly storageRoot: string;
  readonly clock: () => string;
  readonly random?: RandomBytesPort;
  readonly processId?: number;
  readonly liveness?: ProcessLivenessPort;
  readonly port?: number;
  readonly store?: ControlArtifactStore;
  readonly presentationMode?: ControlPresentationMode;
  readonly projectionDataset?: unknown;
  readonly beforeSessionRead?: (signal: AbortSignal) => Promise<void>;
}

export function projectionDataset(
  computedAt = "2026-08-26T10:00:00.000Z",
): Record<string, unknown> {
  return {
    health: {
      startupMode: "fresh",
      stoppedByRestart: 0,
      recoveredSessions: 0,
      unresolvedRuns: 0,
      unconfirmedSessions: 0,
      sweepCompletedAt: computedAt,
      providerHealth: [{
        providerId: "anthropic",
        availability: "available",
        health: "healthy",
        observedAt: computedAt,
      }],
      probes: [{ agent: "claude-code", version: "v1.0.0", probedAt: computedAt }],
      sweepTimings: [{ step: "projections", elapsedMs: 4 }],
      computedAt,
      confidence: "current",
      staleReason: null,
    },
    usageProfiles: [{
      profileId: "profile-owned",
      alias: "aster",
      ownership: "owned",
      provider: "anthropic",
      product: "claude",
      authorisedFor: "development",
      authorization: "authorized",
      revocation: "not-revoked",
      windows: {
        fiveHour: {
          status: "active", usedBp: 2_000, remainingBp: 8_000,
          resetAt: "2026-08-26T12:00:00.000Z", windowId: "window-five",
        },
        weekly: {
          status: "active", usedBp: 3_000, remainingBp: 7_000,
          resetAt: "2026-08-28T08:00:00.000Z", windowId: "window-weekly",
        },
      },
      snapshot: {
        sourceClass: "provider-authoritative",
        authoritative: true,
        sourceConfidence: "high",
        observedAt: computedAt,
        freshUntil: "2026-08-26T10:05:00.000Z",
        schemaVersion: 3,
        failureCode: null,
      },
      eligibility: { eligible: true, ruleIds: [] },
      reservations: [{
        profileId: "profile-owned",
        reservationId: "reservation-one",
        status: "reserved",
        predictedFiveHourBp: 200,
        predictedWeeklyBp: 300,
        taskId: "task-one",
      }],
      computedAt,
      confidence: "current",
      staleReason: null,
    }],
    routingDecisions: [{
      taskId: "task-one",
      decisionId: "decision-one",
      routeAlias: "aster",
      agent: "claude-code",
      reasonCodes: ["deterministic-selection", "owned-profile", "usage-eligible"],
      ruleIds: ["route.deterministic-selection"],
      decidedAt: computedAt,
      evidenceAt: computedAt,
      computedAt,
      confidence: "current",
      staleReason: null,
    }],
  };
}

export async function startControlServiceForTest(options: ControlServiceTestingOptions): Promise<ControlServiceHandle> {
  return await startControlServiceInternal({
    store: options.store ?? createControlArtifactStore({ root: options.storageRoot }),
    clock: options.clock,
    ...(options.random === undefined ? {} : { random: options.random }),
    processId: options.processId ?? process.pid,
    liveness: options.liveness ?? Object.freeze({ inspect: async () => "live" as const }),
    testingPort: options.port ?? 0,
    presentationMode: options.presentationMode ?? "normal",
    projectionDataset: options.projectionDataset ?? projectionDataset(options.clock()),
    ...(options.beforeSessionRead === undefined ? {} : { beforeSessionRead: options.beforeSessionRead }),
  });
}
