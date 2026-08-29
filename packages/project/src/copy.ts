import type {
  BlockerKind, NeedsYouKind, NotificationCategory, ProjectDeepLinkRoute,
} from "./contracts.js";
import { refuse } from "./errors.js";

export interface BlockerCopy {
  readonly statement: string;
  readonly unblockedBy: readonly string[];
  readonly operatorActionable: boolean;
}

function blockerCopy(statement: string, unblockedBy: string, operatorActionable: boolean): BlockerCopy {
  return Object.freeze({ statement, unblockedBy: Object.freeze([unblockedBy]), operatorActionable });
}

/** Finite product copy. No model, path, digest, usage value, or argument is interpolated. */
export function deriveBlockerCopy(kind: BlockerKind): BlockerCopy {
  switch (kind) {
    case "awaiting-approval": return blockerCopy("Approval is required.", "Review the approval request.", true);
    case "awaiting-clarification": return blockerCopy("Operator input is required.", "Open the task input request.", true);
    case "awaiting-spending-decision": return blockerCopy("A spending decision is required.", "Review the spending request.", true);
    case "usage-capped": return blockerCopy("The configured usage cap blocks this task.", "Wait for eligible capacity.", false);
    case "usage-stale": return blockerCopy("Fresh usage evidence is required.", "Wait for one fresh authorized usage snapshot.", false);
    case "provider-unavailable": return blockerCopy("No eligible provider is currently available.", "Wait for an eligible provider.", false);
    case "dependency-failed": return blockerCopy("A required earlier task did not complete.", "Resolve or replace the failed dependency.", true);
    case "policy-denied": return blockerCopy("Policy does not permit this task.", "Change the task to fit policy.", true);
    case "production-refused": return blockerCopy("Production execution is disabled.", "Keep the task in the development boundary.", false);
    case "workspace-conflict": return blockerCopy("The workspace binding is not safe to use.", "Resolve the workspace conflict.", true);
    case "budget-exhausted": return blockerCopy("The task budget is exhausted.", "Review the project budget decision.", true);
    case "emergency-stop": return blockerCopy("The emergency stop blocks this task.", "Review the emergency-stop state.", true);
    case "operator-paused": return blockerCopy("This task was paused by the operator.", "Review whether to resume with a new run.", true);
    default: return assertNever(kind);
  }
}

export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

function notificationCopy(title: string, body: string): NotificationCopy {
  return Object.freeze({ title, body });
}

/** Finite serializer templates. The records contain no interpolated arguments. */
export function deriveNotificationCopy(category: NotificationCategory): NotificationCopy {
  switch (category) {
    case "approval-requested": return notificationCopy("Approval needed", "A project action is waiting for your approval.");
    case "spending-decision-requested": return notificationCopy("Spending decision needed", "A spending request is waiting for your decision.");
    case "task-completed": return notificationCopy("Task completed", "A project task completed successfully.");
    case "task-blocked": return notificationCopy("Task blocked", "A project task is blocked and needs review.");
    case "task-failed": return notificationCopy("Task failed", "A project task ended without satisfying its acceptance checks.");
    case "stage-gate-ready": return notificationCopy("Checkpoint ready", "A project checkpoint is ready for your review.");
    case "usage-stale": return notificationCopy("Usage evidence needs refresh", "Fresh authorized usage evidence is required.");
    case "provider-unavailable": return notificationCopy("Provider unavailable", "No eligible provider is currently available.");
    case "emergency-stop-activated": return notificationCopy("Emergency stop active", "The emergency stop is active; review the in-app status.");
    case "session-termination-unconfirmed": return notificationCopy("Stop not confirmed", "A session did not confirm that it stopped.");
    case "engine-lifecycle": return notificationCopy("Engine status changed", "The engine lifecycle changed; review the in-app status.");
    case "daily-summary": return notificationCopy("Daily project summary", "Your typed project summary is ready in the app.");
    case "input-requested": return notificationCopy("Task input needed", "A task asked for operator input in the app.");
    default: return assertNever(category);
  }
}

export function notificationDeepLinkRoute(category: NotificationCategory): ProjectDeepLinkRoute {
  switch (category) {
    case "approval-requested": return "approval";
    case "spending-decision-requested": return "spending";
    case "task-completed": case "task-blocked": case "task-failed": case "input-requested": return "task";
    case "stage-gate-ready": return "plan";
    case "usage-stale": case "provider-unavailable": return "providers";
    case "emergency-stop-activated": return "emergency-stop";
    case "session-termination-unconfirmed": return "session";
    case "engine-lifecycle": return "home";
    case "daily-summary": return "activity";
    default: return assertNever(category);
  }
}

export function deriveNeedsYouTitle(kind: NeedsYouKind): string {
  switch (kind) {
    case "approval": return "Review an approval";
    case "money": return "Review a spending decision";
    case "question": return "Answer a task question";
    case "blocker": return "Resolve a project blocker";
    case "stage-gate": return "Review the stage checkpoint";
    default: return assertNever(kind);
  }
}

export function needsYouDeepLinkRoute(kind: NeedsYouKind): ProjectDeepLinkRoute {
  switch (kind) {
    case "approval": return "approval";
    case "money": return "spending";
    case "question": case "blocker": return "task";
    case "stage-gate": return "plan";
    default: return assertNever(kind);
  }
}

function assertNever(value: never): never {
  return refuse("INVARIANT_VIOLATION", "projection", "A closed project copy union was not handled.");
}
