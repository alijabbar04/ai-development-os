import { expect, it } from "vitest";
import { parsePlanningCommand, planningArray, planningObject } from "../src/planning-validation.js";
const command = { kind: "create-project", commandId: "input:create", name: "Valid local project", objective: "Describe an arbitrary local project", outcomes: [], budgetMinorUnits: 0, currency: "GBP" };
it.each([
  null, [], new Date(), Object.assign(Object.create({ actor: "owner" }), command),
  { ...command, actor: "owner" }, { ...command, head: "a".repeat(40) }, { ...command, operatorConfirmed: true }, { ...command, kind: "run-task" },
  { ...command, name: "\u202ehidden" }, { ...command, objective: "-----BEGIN PRIVATE KEY-----" }, { ...command, objective: "Bearer ownedSyntheticValue" },
  { ...command, objective: "https://user:owned-marker@example.invalid/" }, { ...command, currency: "JPY" }, { ...command, budgetMinorUnits: -1 },
  { ...command, budgetMinorUnits: Number.MAX_SAFE_INTEGER }, { ...command, commandId: "../escape" }, { ...command, outcomes: Array(2) },
  { kind: "save-plan", commandId: "input:save", projectId: "prj:owned", expectedPlanVersion: 0, title: "Plan", tasks: [], scope: "within-brief" },
  { kind: "save-plan", commandId: "input:save", projectId: "prj:owned", expectedPlanVersion: 0, title: "Plan", tasks: [{ title: "Task", objective: "Objective", acceptanceCriteria: [] }], scope: "within-brief" },
  { kind: "historical-money", commandId: "input:history", projectId: "prj:owned", approvalId: "apr:owned", expectedApprovalVersion: 3, expectedSpendingVersion: 4, action: "record-receipt", receiptRef: "a".repeat(64) },
  { kind: "historical-money", commandId: "input:history", projectId: "prj:owned", approvalId: "apr:owned", expectedApprovalVersion: 3, expectedSpendingVersion: 4, action: "authorize", receiptRef: null },
  { kind: "accept-brief", commandId: "input:brief", projectId: "prj:owned", candidateId: "candidate:owned", candidateDigest: "invalid", expectedBriefVersion: 0 },
  { kind: "stop-project", commandId: "input:stop", projectId: "task:other-scope", expectedProjectVersion: 1 },
])("rejects hostile renderer material %# without converting it to authority", (value) => { expect(() => parsePlanningCommand(value)).toThrow(); });
it("rejects accessors, symbols, hidden fields and sparse collections without executing getters", () => {
  let executed = false;
  const getter = Object.defineProperty({ ...command }, "name", { enumerable: true, get: () => { executed = true; return "forged"; } });
  expect(() => parsePlanningCommand(getter)).toThrow(); expect(executed).toBe(false);
  expect(() => planningObject({ [Symbol("authority")]: true })).toThrow();
  expect(() => planningObject(Object.defineProperty({}, "authority", { value: true }))).toThrow();
  expect(() => planningArray(Object.assign([], { operatorConfirmed: true }), (value) => value)).toThrow();
  expect(parsePlanningCommand(command)).toEqual(command);
});
