import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STATE_MACHINE, APPROVAL_STATE_MACHINE, BLOCKER_STATE_MACHINE,
  HANDOVER_STATE_MACHINE, NOTIFICATION_DELIVERY_STATE_MACHINE, PLAN_STATE_MACHINE,
  PROJECT_STATE_MACHINE, ProjectContractError, SESSION_STATE_MACHINE,
  SPENDING_STATE_MACHINE, TASK_STATE_MACHINE, deriveRecoveryDirective,
  nextRevision, transition,
  type TotalStateMachine,
} from "../src/index.js";

type AnyMachine = TotalStateMachine<string, string>;

const independentLegalEdges: Readonly<Record<string, readonly string[]>> = Object.freeze({
  project: ["active|pause|paused", "paused|resume|active", "active|archive|archived", "paused|archive|archived"],
  plan: [
    "drafting|blocking-questions-found|clarifying", "clarifying|clarifications-recorded|drafting", "drafting|validation-passed|proposed",
    "proposed|scope-approval-required|awaiting_scope_approval", "awaiting_scope_approval|scope-approval-consumed|proposed", "awaiting_scope_approval|scope-rejected|rejected",
    "proposed|seal|sealed", "sealed|dispatch-first-task|executing", "executing|request-expansion|expanding", "expanding|seal-expansion|executing",
    "expanding|refuse-expansion|executing", "executing|stage-gate-reached|stage_gate", "stage_gate|accept-stage-gate|executing",
    "stage_gate|revise-at-gate|superseded", "executing|complete|completed", "executing|halt|halted", "halted|resume|executing",
    "halted|abandon|abandoned", "drafting|abandon|abandoned", "proposed|draft-new-revision|superseded", "sealed|seal-new-revision|superseded",
  ],
  task: [
    "pending|dependencies-succeeded|ready", "pending|dependency-ended-unsuccessfully|blocked", "ready|lease-run|running",
    "running|acceptance-satisfied|succeeded", "running|retry-exhausted|failed", "running|wait|waiting", "waiting|blocker-cleared|running",
    "running|resolution-required|needs_resolution", "needs_resolution|resolution-accepted|running", "needs_resolution|resolution-impossible|failed",
    "blocked|upstream-recovered|pending", "pending|cancel|cancelled", "ready|cancel|cancelled", "running|cancel|cancelled",
    "waiting|cancel|cancelled", "needs_resolution|cancel|cancelled", "blocked|cancel|cancelled",
  ],
  agentRun: [
    "leased|dispatch-started|running", "leased|cancel|cancelled", "leased|lease-expired|abandoned", "running|terminal-success|succeeded",
    "running|terminal-failure|failed", "running|cancel|cancelled", "running|heartbeat-lost|abandoned",
    "abandoned|reconciliation-proved-success|succeeded", "abandoned|reconciliation-proved-failure|failed",
  ],
  session: [
    "requested|prepare|preparing", "preparing|spawn|starting", "preparing|preparation-refused|failed", "starting|handshake-complete|running",
    "starting|handshake-failed|failed", "running|input-requested|awaiting_input", "awaiting_input|input-supplied|running",
    "awaiting_input|stop|stopping", "running|stop|stopping", "running|heartbeat-missed|lost", "lost|heartbeat-resumed|running",
    "lost|lease-expired|orphaned", "stopping|termination-confirmed|stopped", "stopping|termination-unconfirmed|termination_unconfirmed",
    "orphaned|reconciliation-proved-gone|stopped", "orphaned|force-stop-unconfirmed|termination_unconfirmed", "stopped|archive|archived",
    "failed|archive|archived", "termination_unconfirmed|operator-acknowledged|archived",
  ],
  handover: ["assembled|queue|queued", "queued|acknowledge|acknowledged", "queued|expire|expired", "queued|void|voided"],
  approval: [
    "requested|approve|approved", "requested|reject|rejected", "requested|expire|expired", "requested|void|voided",
    "approved|consume-one|consumed", "approved|consume-partial|partially_consumed", "partially_consumed|consume-partial|partially_consumed",
    "partially_consumed|consume-ceiling|consumed", "approved|revoke|revoked", "partially_consumed|revoke|revoked",
    "approved|expire|expired", "partially_consumed|expire|expired", "approved|void|voided", "partially_consumed|void|voided",
  ],
  spending: [
    "drafted|quote|quoted", "quoted|request-approval|awaiting_approval", "awaiting_approval|authorize|authorized",
    "awaiting_approval|decline|declined", "awaiting_approval|expire-quote|quote_expired", "quote_expired|requote|quoted",
    "authorized|operator-reports-executed|operator_executed", "authorized|withdraw|withdrawn", "operator_executed|record-receipt|reconciled",
  ],
  blocker: ["open|clear|cleared"],
  notificationDelivery: ["pending|send|sent", "pending|fail|failed", "pending|suppress|suppressed", "pending|expire|expired", "failed|retry|pending", "failed|expire|expired"],
});

const machines: Readonly<Record<string, AnyMachine>> = {
  project: PROJECT_STATE_MACHINE, plan: PLAN_STATE_MACHINE, task: TASK_STATE_MACHINE,
  agentRun: AGENT_RUN_STATE_MACHINE, session: SESSION_STATE_MACHINE, handover: HANDOVER_STATE_MACHINE,
  approval: APPROVAL_STATE_MACHINE, spending: SPENDING_STATE_MACHINE, blocker: BLOCKER_STATE_MACHINE,
  notificationDelivery: NOTIFICATION_DELIVERY_STATE_MACHINE,
};

describe("explicit total state machines", () => {
  it("matches the independent legal-edge oracle for every state/event cell", () => {
    for (const [name, machine] of Object.entries(machines)) {
      const expected = new Set(independentLegalEdges[name]);
      expect(expected.size, name).toBe(independentLegalEdges[name]?.length);
      let legalCount = 0;
      for (const state of machine.states) {
        expect(Object.keys(machine.table[state]).sort(), `${name}:${state}`).toEqual([...machine.events].sort());
        for (const event of machine.events) {
          const next = machine.table[state][event];
          const key = `${state}|${event}|${next ?? ""}`;
          if (next === null) {
            expect(() => transition(machine, state, event), `${name}:${state}:${event}`).toThrowError(ProjectContractError);
          } else {
            legalCount += 1;
            expect(expected.has(key), key).toBe(true);
            expect(transition(machine, state, event)).toBe(next);
          }
        }
      }
      expect(legalCount, name).toBe(expected.size);
    }
  });

  it("keeps terminal inventories explicit and without outgoing edges", () => {
    const expectedTerminals: Readonly<Record<string, readonly string[]>> = {
      project: ["archived"], plan: ["rejected", "completed", "abandoned", "superseded"],
      task: ["succeeded", "failed", "cancelled"], agentRun: ["succeeded", "failed", "cancelled"],
      session: ["archived"], handover: ["acknowledged", "expired", "voided"],
      approval: ["rejected", "expired", "voided", "consumed", "revoked"], spending: ["declined", "withdrawn", "reconciled"],
      blocker: ["cleared"], notificationDelivery: ["sent", "suppressed", "expired"],
    };
    for (const [name, machine] of Object.entries(machines)) {
      expect(machine.terminal, name).toEqual(expectedTerminals[name]);
      for (const state of machine.terminal) expect(Object.values(machine.table[state]).every((next) => next === null), `${name}:${state}`).toBe(true);
    }
  });

  it("refuses unknown runtime state and event values", () => {
    expect(() => transition(PROJECT_STATE_MACHINE as AnyMachine, "unknown", "pause")).toThrowError(ProjectContractError);
    expect(() => transition(PROJECT_STATE_MACHINE as AnyMachine, "active", "unknown")).toThrowError(ProjectContractError);
  });
});

describe("revision and recovery guards", () => {
  it("advances revisions deterministically and refuses overflow or malformed input", () => {
    expect(nextRevision(1)).toBe(2);
    expect(() => nextRevision(Number.MAX_SAFE_INTEGER)).toThrowError(ProjectContractError);
    expect(() => nextRevision(0)).toThrowError(ProjectContractError);
    expect(() => nextRevision(1.5)).toThrowError(ProjectContractError);
  });

  it("keeps plan states as transition data without an authority field", () => {
    for (const state of PLAN_STATE_MACHINE.states) {
      expect(Object.hasOwn(PLAN_STATE_MACHINE.table[state], "schedulingAuthorized"), state).toBe(false);
      expect(Object.hasOwn(PLAN_STATE_MACHINE.table[state], "authority"), state).toBe(false);
    }
  });

  it("never invents recovery success or auto-retries an irreversible unknown effect", () => {
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: "orphaned", effectPhase: "possibly-dispatched", idempotencyClass: "irreversible", reconciliation: "unresolved", termination: "unconfirmed" })).toBe("operator-acknowledgement-required");
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: "orphaned", effectPhase: "possibly-dispatched", idempotencyClass: "irreversible", reconciliation: "unresolved", termination: "confirmed-gone" })).toBe("fresh-approval-and-resolution-required");
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: "stopped", effectPhase: "pre-dispatch", idempotencyClass: "replayable", reconciliation: "unresolved", termination: "confirmed-gone" })).toBe("explicit-retry-eligible");
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: "stopped", effectPhase: "post-response", idempotencyClass: "reconcilable", reconciliation: "proved-success", termination: "confirmed-gone" })).toBe("mark-succeeded-and-reconcile-usage");
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: null, effectPhase: "pre-dispatch", idempotencyClass: "pure", reconciliation: "proved-failure", termination: "not-applicable" })).toBe("mark-failed");
    expect(deriveRecoveryDirective({ runState: "running", sessionState: "running", effectPhase: "possibly-dispatched", idempotencyClass: "pure", reconciliation: "not-run", termination: "not-applicable" })).toBe("none");
    expect(deriveRecoveryDirective({ runState: "abandoned", sessionState: "orphaned", effectPhase: "pre-dispatch", idempotencyClass: "pure", reconciliation: "not-run", termination: "not-applicable" })).toBe("force-stop-first");
  });
});
