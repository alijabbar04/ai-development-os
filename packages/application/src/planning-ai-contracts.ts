/** Renderer data only. No model selection, executable, credential or authority. */
export interface AiPlanningUnderstanding {
  readonly summary: string;
  readonly outcomes: readonly string[];
  readonly nonGoals: readonly string[];
  readonly audiences: readonly string[];
  readonly assumptions: readonly string[];
}
export interface AiPlanningQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly whyItMatters: string;
  readonly proposedDefault: string;
  readonly blocking: boolean;
}
export interface AiPlanningClarificationRound {
  readonly round: 1 | 2;
  readonly requestId: string;
  readonly questions: readonly AiPlanningQuestion[];
  readonly answers: readonly Readonly<{ questionId: string; value: string }>[];
  readonly materialChangeReason: string | null;
}
export interface AiPlanningProposal {
  readonly title: string;
  readonly tasks: readonly Readonly<{ taskId: string; title: string; objective: string; acceptanceCriteria: readonly string[]; dependsOn: readonly string[] }>[];
}
export interface AiPlanningDraft {
  readonly description: string;
  readonly includeRepositorySummary: boolean;
  readonly answers: readonly Readonly<{ questionId: string; value: string }>[];
  readonly understanding: AiPlanningUnderstanding | null;
  readonly proposal: AiPlanningProposal | null;
}
interface AiPlanningSubject {
  readonly commandId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedSessionVersion: number;
}
export type AiPlanningCommand =
  | Readonly<{ kind: "start-ai-planning"; commandId: string; projectId: string; expectedSessionVersion: number; description: string; includeRepositorySummary: boolean }>
  | (AiPlanningSubject & Readonly<{ kind: "save-ai-planning-draft"; draft: AiPlanningDraft }>)
  | (AiPlanningSubject & Readonly<{ kind: "request-ai-understanding" | "request-ai-proposal" | "accept-ai-brief" | "adopt-ai-proposal"; contextDigest: string }>)
  | Readonly<{ kind: "cancel-ai-request"; commandId: string; projectId: string; sessionId: string; requestId: string }>;
export interface AiPlanningConnectionView {
  readonly state: "LIVE_ROUTE_BLOCKED" | "qualified";
  readonly source: "unqualified" | "owned-subscription" | "synthetic-fixture";
  readonly provider: string;
  readonly modelId: string | null;
  readonly detail: string;
  readonly remainingAllowance: "unknown";
  readonly configurationFingerprint: string | null;
}
export type AiPlanningRequestState = "intent" | "admitted" | "dispatched" | "succeeded" | "refused" | "failed" | "cancelled" | "outcome-unknown" | "stale";
export interface AiPlanningRequestView {
  readonly modelNotes?: Readonly<{ objective: string; assumptions: readonly string[]; risks: readonly string[]; openQuestions: readonly string[]; detailsOmitted?: boolean }> | null;
  readonly requestId: string;
  readonly purpose: "understanding" | "proposal";
  readonly state: AiPlanningRequestState;
  readonly reason: string | null;
  readonly usageState: "not-called" | "reported" | "unknown";
  readonly modelId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly contributionDigest: string | null;
}
export interface AiPlanningSessionView {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestCount: number;
  readonly maxRequests: 3;
  readonly clarificationRounds: number;
  readonly maxClarificationRounds: 2;
  readonly draft: AiPlanningDraft;
  readonly understandingContributionDigest: string | null;
  readonly proposalContributionDigest: string | null;
  readonly acceptedBriefDigest: string | null;
  readonly adoptedPlanDigest: string | null;
  readonly questions: readonly AiPlanningQuestion[];
  readonly clarificationHistory: readonly AiPlanningClarificationRound[];
  readonly requests: readonly AiPlanningRequestView[];
  readonly activeRequestId: string | null;
}
export interface AiPlanningProjectView {
  readonly version: number;
  readonly contextDigest: string;
  readonly currentSession: AiPlanningSessionView | null;
  readonly sessions: readonly AiPlanningSessionView[];
}
