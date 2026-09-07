import type { DesktopPresentationSource } from "../presentation/adapter.js";
import { adaptWorkspacePresentation } from "../presentation/adapter.js";

const preparedAt = "2026-09-07T09:30:00.000Z";

export const WORKSPACE_EXAMPLE = adaptWorkspacePresentation({
  example: true,
  label: "Synthetic example — local preview only, not saved",
  observedAt: preparedAt,
  project: {
    displayName: "Neighbourhood repair booking",
    status: "active",
    planState: "Needs your approval to start",
    counts: { running: 0, waiting: 2, blocked: 0, awaitingApproval: 1, queued: 0, done: 1, total: 3 },
    confidence: "current",
    computedAt: preparedAt,
  },
  brief: {
    revision: 1,
    objective: "Create a clear booking experience for a small home-repair team.",
    outcomes: ["Customers can request a visit", "The team can review a concise request summary"],
    nonGoals: ["Taking payments", "Dispatching contractors automatically"],
    audiences: ["Homeowners", "Repair coordinators"],
    assumptions: [{ text: "Requests are reviewed during local business hours", source: "model", confirmed: false }],
    openQuestions: [],
    createdAt: preparedAt,
  },
  plan: {
    revision: 1,
    state: "awaiting_scope_approval",
    stages: [
      {
        stageId: "stg:example-foundation",
        ordinal: 1,
        title: "Shape the booking journey",
        intent: "Turn the accepted brief into a small, testable customer flow.",
        exitCriteria: ["The journey is keyboard accessible"],
        exitEvidenceKinds: ["test"],
        taskIds: ["tsk:example-form", "tsk:example-summary"],
        gate: "operator-review",
      },
      {
        stageId: "stg:example-review",
        ordinal: 2,
        title: "Review the example",
        intent: "Check the proposed experience before any real implementation is connected.",
        exitCriteria: ["The operator understands what remains disconnected"],
        exitEvidenceKinds: ["review"],
        taskIds: ["tsk:example-review"],
        gate: "operator-review",
      },
    ],
    tasks: [
      { taskId: "tsk:example-form" },
      { taskId: "tsk:example-summary" },
      { taskId: "tsk:example-review" },
    ],
    dependencies: [{ fromTaskId: "tsk:example-summary", toTaskId: "tsk:example-review", kind: "finish-to-start", artifactKind: null }],
    authority: "none",
  },
  planActions: [{
    action: "seal",
    label: "Approval is not connected in this first-light build",
    enabled: false,
    disabledReason: "This is a synthetic example. No project or approval write is available.",
  }],
  approval: {
    class: "scope-expansion",
    risk: "medium",
    subjectSummary: {
      what: "Allow changes inside one named project workspace",
      why: "The example plan would need a bounded place for future files.",
      changes: "Would permit project-scoped file edits after real integration.",
      where: "One explicitly selected workspace",
      reversible: true,
      scope: "Example project workspace only",
      effects: ["Future file changes inside the approved root"],
      exclusions: ["No publication", "No provider call", "No credential access"],
    },
    usage: "one-shot",
    effects: ["Would allow a future bounded workspace write"],
    exclusions: ["Does not start work", "Does not approve spending", "Does not publish"],
    state: "requested",
    expiresAt: "2026-09-08T09:30:00.000Z",
    money: null,
  },
} satisfies DesktopPresentationSource);
