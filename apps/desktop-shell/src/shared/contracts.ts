export const DESKTOP_PROTOCOL = "app-ai-powerhouse" as const;
export const DESKTOP_PROTOCOL_HOST = "workspace" as const;
export const DESKTOP_ENTRY_URL = `${DESKTOP_PROTOCOL}://${DESKTOP_PROTOCOL_HOST}/renderer/index.html` as const;
export const DESKTOP_SESSION_PARTITION = "ai-powerhouse-desktop-development" as const;
export const DESKTOP_SESSION_ARGUMENT = "--desktop-session-token=" as const;

export const DESKTOP_CHANNELS = Object.freeze({
  snapshot: "desktop-shell:snapshot",
  retryService: "desktop-shell:retry-service",
  openReadOnly: "desktop-shell:open-read-only",
  setPreferences: "desktop-shell:set-preferences",
  relaunch: "desktop-shell:relaunch",
  quit: "desktop-shell:quit",
  planningSnapshot: "desktop-shell:planning-snapshot",
  planningCommand: "desktop-shell:planning-command",
  planningObserve: "desktop-shell:planning-observe",
  planningHandover: "desktop-shell:planning-handover",
  stateChanged: "desktop-shell:state-changed",
} as const);

export type DesktopRequestChannel = Exclude<(typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS], typeof DESKTOP_CHANNELS.stateChanged>;
export type PresentationMode = "normal" | "developer";
export type TextScale = "standard" | "large";

export interface DesktopPreferences {
  readonly schemaVersion: 1;
  readonly presentationMode: PresentationMode;
  readonly textScale: TextScale;
  readonly welcomeDismissed: boolean;
}

export interface UsagePolicyPresentation {
  readonly source: "published-policy-contract";
  readonly timezone: "Europe/London";
  readonly weekdays: readonly ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  readonly workHours: "09:00–17:00";
  readonly borrowedFiveHourCapPercent: 50;
  readonly borrowedWeeklyCapPercent: 70;
  readonly currentUsage: "unknown";
  readonly eligibility: "unknown";
}

export interface ServiceObservation {
  readonly freshness: "live" | "stale";
  readonly observedAt: string;
  readonly ageMs: number;
  readonly serviceVersion: string;
  readonly presentationMode: PresentationMode;
  readonly runningSessions: number;
  readonly verification: "identity-verified-connection-closed";
  readonly dataSource: "owned-synthetic-development-service";
  readonly authority: "none";
  readonly commands: readonly [];
}

export type DesktopServiceState = "loading" | "ready" | "service-lost" | "failed-start" | "read-only";

export interface DesktopDiagnostics {
  readonly serviceVersion: string | null;
  readonly presentationMode: PresentationMode;
  readonly ownsChild: true;
  readonly verificationConnection: "closed-after-check";
  readonly runtimeRoot: "dedicated-disposable-development-root";
}

export interface DesktopSnapshot {
  readonly schemaVersion: 1;
  readonly state: DesktopServiceState;
  readonly statusText: string;
  readonly firstLaunch: boolean;
  readonly recoveryAvailable: boolean;
  readonly readOnlyAvailable: boolean;
  readonly observation: ServiceObservation | null;
  readonly usagePolicy: UsagePolicyPresentation;
  readonly preferences: DesktopPreferences;
  readonly authority: "none";
  readonly commands: readonly [];
  readonly diagnostics: DesktopDiagnostics | null;
}

export type DesktopRefusalCode = "INVALID_REQUEST" | "SENDER_REJECTED" | "TOKEN_REJECTED" | "ACTION_UNAVAILABLE" | "SERVICE_UNAVAILABLE";

export type DesktopResult<T> =
  | Readonly<{ schemaVersion: 1; requestId: string; ok: true; value: T }>
  | Readonly<{ schemaVersion: 1; requestId: string; ok: false; code: DesktopRefusalCode }>;

export interface DesktopRequestEnvelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionToken: string;
}

export interface DesktopPreferenceUpdate extends DesktopRequestEnvelope {
  readonly preferences: DesktopPreferences;
}

export interface DesktopPlanningRequest extends DesktopRequestEnvelope {
  readonly planning: unknown;
}
