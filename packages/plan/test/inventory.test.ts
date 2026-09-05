import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as intake from "@ai-dev-os/intake";
import {
  PLAN_EVENTS as C6_PLAN_EVENTS,
  PLAN_STATES as C6_PLAN_STATES,
  PLAN_STATE_MACHINE as C6_PLAN_STATE_MACHINE,
} from "@ai-dev-os/project";
import { PLAN_RULE_IDS } from "../src/index.js";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");

const EXPECTED_API_CODES = [
  "BLOCKED_BY_ESTOP", "BLOCKED_BY_PROJECT_STOP", "BLOCKED_DISPATCH_PAUSED",
  "SERVICE_NOT_READY", "IDENTITY_MISMATCH", "SCHEMA_AHEAD", "IDEMPOTENCY_REPLAY",
  "PAYLOAD_TOO_LARGE", "RATE_LIMITED", "DIGEST_MISMATCH", "ROOT_UNREADABLE",
  "ROOT_NOT_CONTAINED", "BRIEF_SUPERSEDED", "BLOCKING_UNANSWERED", "SET_SUPERSEDED",
  "PLAN_SEALED", "REVISION_STALE", "SEAL_CONDITION_FAILED", "APPROVAL_REQUIRED",
  "EXPANSION_BOUND_EXCEEDED", "PLAN_NOT_EXECUTING", "GATE_NOT_READY", "NOT_ELIGIBLE",
  "PRODUCTION_REFUSED", "LIVE_SESSION_EXISTS", "PAID_ROUTE_REQUIRES_APPROVAL",
  "PROJECT_PAUSED", "PROJECT_STOPPED", "HANDOVER_NOT_READY", "NO_OPEN_QUESTION",
  "SESSION_NOT_AWAITING", "TEXT_TOO_LONG", "TASK_NOT_OPEN", "BOUND_VIOLATION",
  "BLOCKER_CLEARED", "OPTION_PRECONDITION_UNMET", "RETRY_EXHAUSTED",
  "RECONCILIATION_PENDING", "IRREVERSIBLE_REQUIRES_APPROVAL",
  "HANDOVER_ALREADY_CONSUMED", "SESSION_NOT_RUNNING", "TERMINATION_UNCONFIRMED",
  "BINDING_MISMATCH", "NOT_RESUMABLE", "SESSION_TERMINAL", "UNPROVEN_TERMINATION",
  "RUN_NOT_TERMINAL", "PLAN_REVISION_MOVED", "TASK_NOT_IN_PLAN", "APPROVAL_NOT_OPEN",
  "APPROVAL_EXPIRED", "ACTOR_NOT_OPERATOR", "NOT_REVOCABLE", "AMOUNT_OUT_OF_BOUNDS",
  "QUOTE_LOCKED", "NOT_AUTHORIZED_STATE", "REMINDER_TOO_LATE", "PROJECT_ARCHIVED",
  "ESTOP_NOT_READY", "ESTOP_PARTIAL", "ESTOP_NOT_ENGAGED", "SESSION_NOT_UNCONFIRMED",
  "EDITOR_UNAVAILABLE", "PATH_NOT_APPROVED", "DESCRIPTOR_UNVERIFIED", "REFRESH_LIMIT",
  "CATEGORY_LOCKED", "APPROVAL_NOT_CONSUMABLE", "SCOPE_MISMATCH", "EFFECT_FAILED",
] as const;

const PLAN_RELEVANT_API_CODES = [
  "PLAN_SEALED", "REVISION_STALE", "SEAL_CONDITION_FAILED", "APPROVAL_REQUIRED",
  "EXPANSION_BOUND_EXCEEDED", "PLAN_NOT_EXECUTING", "GATE_NOT_READY", "NOT_ELIGIBLE",
  "PLAN_REVISION_MOVED", "TASK_NOT_IN_PLAN", "BRIEF_SUPERSEDED", "BLOCKING_UNANSWERED",
  "SET_SUPERSEDED", "DIGEST_MISMATCH", "PRODUCTION_REFUSED", "PAYLOAD_TOO_LARGE",
  "PROJECT_PAUSED", "PROJECT_ARCHIVED", "BLOCKED_BY_PROJECT_STOP", "SERVICE_NOT_READY",
  "IDEMPOTENCY_REPLAY",
] as const;

const C9_WIRE_MAPPINGS = [
  ["plan.brief.blocking-unanswered", "BLOCKING_UNANSWERED"],
  ["plan.brief.superseded", "BRIEF_SUPERSEDED"],
  ["plan.event.too-large", "PAYLOAD_TOO_LARGE"],
  ["plan.graph.fan-in", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.fan-out", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.stage-too-large", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.too-deep", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.too-many-dependencies", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.too-many-stages", "SEAL_CONDITION_FAILED{2}"],
  ["plan.graph.too-many-tasks", "SEAL_CONDITION_FAILED{2}"],
  ["plan.project.not-active", "PROJECT_PAUSED|PROJECT_ARCHIVED"],
  ["plan.project.stopped", "BLOCKED_BY_PROJECT_STOP"],
  ["plan.proposal.digest-mismatch", "DIGEST_MISMATCH"],
  ["plan.proposal.stale", "DIGEST_MISMATCH"],
  ["plan.revision.stale", "REVISION_STALE"],
  ["plan.seal.condition-1", "SEAL_CONDITION_FAILED{1}"],
  ["plan.seal.condition-2", "SEAL_CONDITION_FAILED{2}"],
  ["plan.seal.condition-3", "SEAL_CONDITION_FAILED{3}"],
  ["plan.seal.condition-4", "SEAL_CONDITION_FAILED{4}"],
  ["plan.seal.condition-5", "SEAL_CONDITION_FAILED{5}"],
  ["plan.seal.condition-6", "SEAL_CONDITION_FAILED{6}+APPROVAL_REQUIRED{class:scope-expansion}"],
  ["plan.sealed.immutable", "PLAN_SEALED"],
  ["plan.size.too-large", "PAYLOAD_TOO_LARGE"],
  ["plan.state.out-of-scope", "PLAN_NOT_EXECUTING"],
  ["plan.store.conflict", "REVISION_STALE"],
  ["plan.store.unavailable", "SERVICE_NOT_READY"],
] as const;

const EXPECTED_INTAKE_RUNTIME = [
  "INTAKE_AUTHORITY", "INTAKE_AVAILABLE_COMMANDS", "INTAKE_BLOCKING_BASES",
  "INTAKE_CLARIFICATION_POLICY", "INTAKE_DIAGNOSTIC_ROOTS", "INTAKE_GIT_QUERIES",
  "INTAKE_INSPECTION_STATES", "INTAKE_LIMITS", "INTAKE_PRODUCTION_ENABLED",
  "INTAKE_PROVENANCE_SOURCES", "INTAKE_QUESTION_SOURCES", "INTAKE_REFUSAL_CODES",
  "INTAKE_RUNTIME_CAPABILITIES", "INTAKE_VIEW_STATES", "IntakeError", "abandonCandidate",
  "acceptCandidate", "applyClarificationsToCandidate", "assembleCandidate",
  "candidateDigestMaterial", "clarificationResolutionAssumptions", "clarificationView",
  "collectRepositoryInspection", "createC7IntakeStore", "createClarificationSession",
  "decisionIdentityMaterial", "exactIntakeKeys", "intakeArray", "intakeRecord",
  "intakeRefusalCopy", "intakeSha256", "intakeStateView", "isIntakeDiagnosticRoot",
  "mapProjectRefusal", "normalProjectionLeakage", "openClarificationRound",
  "parseIntakeAcceptanceEvent", "parseIntakeJsonText", "prepareCandidateAcceptance",
  "projectBriefHistoryView", "projectBriefView", "refuseIntake", "resolveClarificationRound",
  "restartClarification", "semanticIntakeKey", "serializeIntakeProjection",
  "unresolvedBlockingQuestions", "validateDigest", "validateSafeInteger", "verifyCandidate",
  "verifyClarificationSession",
] as const;

const EXPECTED_INTAKE_TYPES = [
  "IntakeBlockingBasis", "IntakeProvenanceSource", "IntakeProvenance", "IntakeTextField",
  "IntakeConstraintField", "IntakeAssumptionField", "IntakeQuestionSource",
  "ProposedIntakeQuestion", "KnownIntakeFact", "CandidateDraftInput", "CandidateBrief",
  "IntakeDigestPort", "IntakeClock", "IntakeMonotonicClock", "ClarificationResolutionKind",
  "ClarificationResolution", "DroppedClarificationQuestion", "ClarificationRound",
  "ClarificationSession", "AcceptanceBinding", "OperatorAcceptanceEvidence",
  "CandidateFieldProvenance", "IntakeAcceptanceEventPayload", "PreparedAcceptance",
  "StoreWriteAttempt", "StoreReconciliation", "IntakeAcceptanceStore",
  "AcceptCandidateRequest", "AcceptanceOutcome", "IntakeInspectionState", "IntakePathFlavor",
  "IntakeFileKind", "IntakeFileObservation", "IntakeFilesystemPort", "IntakeGitQuery",
  "IntakeGitResult", "IntakeGitPort", "RepositoryInspectionRequest",
  "RepositoryInspectionReport", "IntakeViewState", "IntakeAudience",
  "IntakeStateProjectionInput", "IntakeRefusalCode", "IntakeDiagnosticRoot",
  "IntakeErrorDetails", "IntakeRecord",
] as const;

const EXPECTED_C6_STATES = [
  "drafting", "clarifying", "proposed", "awaiting_scope_approval", "rejected", "sealed",
  "executing", "expanding", "stage_gate", "halted", "completed", "abandoned", "superseded",
] as const;

const EXPECTED_C6_EVENTS = [
  "blocking-questions-found", "clarifications-recorded", "validation-passed",
  "scope-approval-required", "scope-approval-consumed", "scope-rejected", "seal",
  "dispatch-first-task", "request-expansion", "seal-expansion", "refuse-expansion",
  "stage-gate-reached", "accept-stage-gate", "revise-at-gate", "complete", "halt", "resume",
  "abandon", "draft-new-revision", "seal-new-revision",
] as const;

const EXPECTED_C6_LEGAL = [
  ["drafting", "blocking-questions-found", "clarifying"],
  ["clarifying", "clarifications-recorded", "drafting"],
  ["drafting", "validation-passed", "proposed"],
  ["proposed", "scope-approval-required", "awaiting_scope_approval"],
  ["awaiting_scope_approval", "scope-approval-consumed", "proposed"],
  ["awaiting_scope_approval", "scope-rejected", "rejected"],
  ["proposed", "seal", "sealed"],
  ["sealed", "dispatch-first-task", "executing"],
  ["executing", "request-expansion", "expanding"],
  ["expanding", "seal-expansion", "executing"],
  ["expanding", "refuse-expansion", "executing"],
  ["executing", "stage-gate-reached", "stage_gate"],
  ["stage_gate", "accept-stage-gate", "executing"],
  ["stage_gate", "revise-at-gate", "superseded"],
  ["executing", "complete", "completed"],
  ["executing", "halt", "halted"],
  ["halted", "resume", "executing"],
  ["halted", "abandon", "abandoned"],
  ["drafting", "abandon", "abandoned"],
  ["proposed", "draft-new-revision", "superseded"],
  ["sealed", "seal-new-revision", "superseded"],
] as const;

const EXPECTED_INVARIANT_IDS = [
  "PR-1", "PR-2", "PR-3", "PR-4", "PR-5", "PR-6",
  "BR-1", "BR-2", "BR-3", "BR-4", "BR-5", "BR-6", "BR-7", "BR-8", "BR-9", "BR-10",
  "PL-1", "PL-2", "PL-3", "PL-4", "PL-5", "PL-6", "PL-7", "PL-8", "PL-9", "PL-10",
  "PL-11", "PL-12", "PL-12b", "PL-13", "PL-14", "PL-15", "PL-16", "PL-17", "PL-18",
  "ST-1", "ST-2", "ST-3", "ST-4", "ST-5", "ST-6", "ST-7", "ST-8", "ST-9",
  "TK-1", "TK-2", "TK-3", "TK-4", "TK-5", "TK-6", "TK-7", "TK-8", "TK-9", "TK-10",
  "TK-11", "TK-12", "TK-13", "TK-14", "TK-15",
  "DP-1", "DP-2", "DP-3", "DP-4", "DP-5", "DP-6", "DP-7", "DP-8", "DP-9", "DP-10", "DP-11",
  "CN-1", "CN-2", "CN-3", "DC-1", "DC-2", "DC-3", "DC-4", "DC-5", "DC-6",
  "BL-1", "BL-2", "DL-1", "DL-2", "EV-1", "EV-2", "UR-1", "UR-2",
  "SP-1", "SP-2", "SP-3", "SP-4", "H-1", "H-2", "H-3", "H-4", "H-5", "H-6", "H-7",
] as const;

const EXPECTED_ACCEPTANCE_IDS = [
  "B-1", "B-2", "B-3", "B-4", "B-5", "B-6", "B-7", "B-8", "B-9", "B-10",
  "B-11", "B-12", "B-13", "B-14", "B-15", "B-16", "B-17", "B-18", "B-19",
  "P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8", "P-9", "P-10",
  "P-11", "P-12", "P-13", "P-14", "P-15", "P-16", "P-17", "P-18", "P-19", "P-20",
  "P-21", "P-22", "P-23", "P-24", "P-25", "P-26", "P-27", "P-28", "P-29", "P-30",
  "P-31", "P-32", "P-33", "P-34", "P-35",
  "M-1", "M-1b", "M-2", "M-3", "M-4", "M-5", "M-6", "M-7", "M-8", "M-9",
  "M-10", "M-11", "M-12", "M-13", "M-14", "M-15", "M-16", "M-17", "M-18", "M-19",
  "M-20", "M-21", "M-22", "M-23",
  "N-1", "N-2", "N-3", "N-4", "N-5", "N-6", "N-7", "N-8", "N-9", "N-10",
  "N-11", "N-12", "N-13", "N-14", "N-15", "N-16", "N-17", "N-18",
  "PV-9", "PV-10", "PV-11", "PV-12", "PV-13", "PV-14", "PV-15", "PV-16",
  "PV-17", "PV-18", "PV-19", "PV-20",
  "SP-1", "SP-2", "SP-3", "SP-4", "SP-5", "SP-6", "SP-7", "SP-8", "SP-9",
  "SP-10", "SP-11", "SP-12",
  "G-0", "G-1", "G-2", "G-3", "G-4", "G-5", "G-6", "G-7", "G-8", "G-9",
  "G-10", "G-11", "G-12", "G-13", "G-14",
] as const;

describe("B-1..B-19 upstream and dossier literal inventories", () => {
  it("pins all 70 API refusal codes and the closed 21-code C9 relevance declaration", () => {
    const apiSource = read("packages/api/src/refusals.ts");
    const body = apiSource.match(/const RAW_REFUSAL_COPY = \{([\s\S]*?)\n\} as const/u)?.[1] ?? "";
    const actual = [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]);
    expect(actual).toEqual(EXPECTED_API_CODES);
    expect(new Set(EXPECTED_API_CODES).size).toBe(70);
    expect(new Set(PLAN_RELEVANT_API_CODES).size).toBe(21);
    expect(PLAN_RELEVANT_API_CODES.every((code) => EXPECTED_API_CODES.includes(code))).toBe(true);
  });

  it("pins all 26 non-null wire mappings over exactly 13 API base codes", () => {
    expect(C9_WIRE_MAPPINGS).toHaveLength(26);
    expect(C9_WIRE_MAPPINGS.every(([ruleId]) => PLAN_RULE_IDS.includes(ruleId as never))).toBe(true);
    const bases = [...new Set(C9_WIRE_MAPPINGS.flatMap(([, wire]) => wire
      .split(/[|+]/u)
      .map((token) => token.replace(/\{.*$/u, ""))))].sort();
    expect(bases).toEqual([
      "APPROVAL_REQUIRED", "BLOCKED_BY_PROJECT_STOP", "BLOCKING_UNANSWERED",
      "BRIEF_SUPERSEDED", "DIGEST_MISMATCH", "PAYLOAD_TOO_LARGE", "PLAN_NOT_EXECUTING",
      "PLAN_SEALED", "PROJECT_ARCHIVED", "PROJECT_PAUSED", "REVISION_STALE",
      "SEAL_CONDITION_FAILED", "SERVICE_NOT_READY",
    ]);
    expect(bases.every((code) => PLAN_RELEVANT_API_CODES.includes(code as never))).toBe(true);
  });

  it("pins exactly 51 intake runtime exports and 46 root type-only exports", () => {
    expect(Object.keys(intake).sort()).toEqual([...EXPECTED_INTAKE_RUNTIME].sort());
    const exportedTypes = ["packages/intake/src/contracts.ts", "packages/intake/src/errors.ts"]
      .flatMap((path) => [...read(path).matchAll(/^export (?:interface|type) ([A-Za-z][A-Za-z0-9]*)/gmu)].map((match) => match[1]));
    const index = read("packages/intake/src/index.ts");
    expect(index).toMatch(/\btype IntakeRecord\b/u);
    expect(index).not.toContain("IntakeTextOptions");
    exportedTypes.push("IntakeRecord");
    expect(exportedTypes.sort()).toEqual([...EXPECTED_INTAKE_TYPES].sort());
    expect(new Set(EXPECTED_INTAKE_RUNTIME).size).toBe(51);
    expect(new Set(EXPECTED_INTAKE_TYPES).size).toBe(46);
  });

  it("pins the unchanged C6 13-state, 20-event, 21-cell durable plan machine", () => {
    expect(C6_PLAN_STATES).toEqual(EXPECTED_C6_STATES);
    expect(C6_PLAN_EVENTS).toEqual(EXPECTED_C6_EVENTS);
    const legal = C6_PLAN_STATES.flatMap((state) => C6_PLAN_EVENTS.flatMap((event) => {
      const target = C6_PLAN_STATE_MACHINE.table[state][event];
      return target === null ? [] : [[state, event, target] as const];
    }));
    const sortCells = (cells: readonly (readonly string[])[]) => [...cells]
      .map((cell) => [...cell])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    expect(sortCells(legal)).toEqual(sortCells(EXPECTED_C6_LEGAL));
    expect(legal).toHaveLength(21);
  });

  it("pins the same 98 unique IDs in the reviewed Markdown and JSON invariant twins", () => {
    const root = "docs/development/stage-20-c9/plan-record-and-invariant-matrix";
    const json = JSON.parse(read(`${root}.json`)) as { invariants: readonly { id: string }[] };
    const markdownIds = [...read(`${root}.md`).matchAll(/^\|\s*([A-Z]{1,4}-[0-9]+[a-z]?)\s*\|/gmu)].map((match) => match[1]);
    const jsonIds = json.invariants.map((invariant) => invariant.id);
    expect(jsonIds).toEqual(EXPECTED_INVARIANT_IDS);
    expect(markdownIds).toEqual(EXPECTED_INVARIANT_IDS);
    expect(new Set(jsonIds).size).toBe(98);
  });

  it("pins every required acceptance range without conflating it with invariant IDs", () => {
    expect(new Set(EXPECTED_ACCEPTANCE_IDS).size).toBe(EXPECTED_ACCEPTANCE_IDS.length);
    expect(EXPECTED_ACCEPTANCE_IDS).toHaveLength(135);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("B-"))).toHaveLength(19);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("P-"))).toHaveLength(35);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("M-"))).toHaveLength(24);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("N-"))).toHaveLength(18);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("PV-"))).toHaveLength(12);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("SP-"))).toHaveLength(12);
    expect(EXPECTED_ACCEPTANCE_IDS.filter((id) => id.startsWith("G-"))).toHaveLength(15);
    expect(EXPECTED_ACCEPTANCE_IDS).toContain("M-1b");
    expect(EXPECTED_ACCEPTANCE_IDS).toContain("G-0");
  });
});
