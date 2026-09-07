import {
  USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP,
  USAGE_POLICY_BORROWED_WEEKLY_CAP_BP,
  USAGE_POLICY_TIMEZONE,
  USAGE_POLICY_WORK_DAYS,
  USAGE_POLICY_WORK_END,
  USAGE_POLICY_WORK_START,
} from "@ai-dev-os/control-service";
import type {
  DesktopDiagnostics,
  DesktopPreferences,
  DesktopServiceState,
  DesktopSnapshot,
  UsagePolicyPresentation,
} from "../shared/contracts.js";
import type { OwnedServiceSnapshot } from "../service/controller.js";

export const USAGE_POLICY_PRESENTATION: UsagePolicyPresentation = Object.freeze({
  source: "published-policy-contract",
  timezone: USAGE_POLICY_TIMEZONE,
  weekdays: Object.freeze([...USAGE_POLICY_WORK_DAYS]) as UsagePolicyPresentation["weekdays"],
  workHours: `${USAGE_POLICY_WORK_START}–${USAGE_POLICY_WORK_END}` as UsagePolicyPresentation["workHours"],
  borrowedFiveHourCapPercent: (USAGE_POLICY_BORROWED_FIVE_HOUR_CAP_BP / 100) as 50,
  borrowedWeeklyCapPercent: (USAGE_POLICY_BORROWED_WEEKLY_CAP_BP / 100) as 70,
  currentUsage: "unknown",
  eligibility: "unknown",
});

function publicState(phase: OwnedServiceSnapshot["phase"]): DesktopServiceState {
  return phase === "stopped" ? "service-lost" : phase;
}

function statusText(state: DesktopServiceState): string {
  switch (state) {
    case "loading": return "Starting the owned local service";
    case "ready": return "Local service verified";
    case "service-lost": return "Local service unavailable";
    case "failed-start": return "Local service did not start";
    case "read-only": return "Read-only view using a stale observation";
  }
}

export function createDesktopSnapshot(service: OwnedServiceSnapshot, preferences: DesktopPreferences): DesktopSnapshot {
  const state = publicState(service.phase);
  const diagnostics: DesktopDiagnostics | null = preferences.presentationMode === "developer"
    ? Object.freeze({
        serviceVersion: service.observation?.serviceVersion ?? null,
        presentationMode: service.presentationMode,
        ownsChild: true,
        verificationConnection: "closed-after-check",
        runtimeRoot: "dedicated-disposable-development-root",
      })
    : null;
  return Object.freeze({
    schemaVersion: 1,
    state,
    statusText: statusText(state),
    firstLaunch: !preferences.welcomeDismissed,
    recoveryAvailable: service.recoveryAvailable,
    readOnlyAvailable: service.observation !== null && state !== "ready",
    observation: service.observation,
    usagePolicy: USAGE_POLICY_PRESENTATION,
    preferences,
    authority: "none",
    commands: Object.freeze([]) as readonly [],
    diagnostics,
  });
}
