import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKSPACE_EXAMPLE } from "../src/examples/workspace-example.js";
import type { PlanningCommandResult, PlanningWorkspaceView } from "@ai-dev-os/application/planning-contracts";
import {
  adaptPlanningWorkspace,
  formatMinorUnits,
  planningRecoveryDirective,
  planningResultMessage,
  shortDigest,
} from "../src/presentation/adapter.js";

describe("workspace presentation adapter", () => {
  it("presents a labelled example without durable identities or authority", () => {
    expect(WORKSPACE_EXAMPLE.example).toBe(true);
    expect(WORKSPACE_EXAMPLE.label).toContain("not saved");
    expect(WORKSPACE_EXAMPLE.plan.authority).toBe("none");
    expect(WORKSPACE_EXAMPLE.plan.actions).toHaveLength(1);
    expect(WORKSPACE_EXAMPLE.plan.actions[0]).toMatchObject({ enabled: false });
    expect(WORKSPACE_EXAMPLE.plan.state).toBe("awaiting scope approval");
    expect(WORKSPACE_EXAMPLE.approval.moneyLabel).toBe("No spending requested");
    const visible = JSON.stringify(WORKSPACE_EXAMPLE);
    expect(visible).not.toMatch(/(?:stg|tsk|apr|pln):/u);
    expect(visible).not.toContain("approvalRequestId");
  });

  it("uses DOM text assignment rather than HTML injection", async () => {
    const source = await readFile(new URL("../src/renderer/components.ts", import.meta.url), "utf8");
    expect(source).toContain("textContent = text");
    expect(source).not.toMatch(/\.innerHTML\s*=/u);
    const broken = `${source}\nelement.innerHTML = hostile;`;
    expect(broken).toMatch(/\.innerHTML\s*=/u);
  });

  it("presents saved planning records without expanding their authority", () => {
    const workspace: PlanningWorkspaceView = Object.freeze({
      schemaVersion: 1,
      authority: "none",
      source: "saved-local-planning",
      aiPlanningConnection: Object.freeze({ state: "LIVE_ROUTE_BLOCKED", source: "unqualified", provider: "claude-code-planning", modelId: null, detail: "Managed policy isolation is unqualified.", remainingAllowance: "unknown", configurationFingerprint: null }),
      projects: Object.freeze([{ projectId: "project-1", name: "Release readiness", version: 4, stopped: false, planState: "awaiting_scope_approval" }]),
      selected: Object.freeze({
        projectId: "project-1",
        name: "Release readiness",
        version: 4,
        stopped: false,
        planState: "awaiting_scope_approval",
        budget: Object.freeze({ minorUnits: 125_050, currency: "GBP" }),
        repository: null,
        brief: null,
        candidate: null,
        plan: null,
        approvals: Object.freeze([]),
        handovers: Object.freeze([]),
        history: Object.freeze([]),
        aiPlanning: Object.freeze({ version: 0, contextDigest: "0".repeat(64), currentSession: null, sessions: Object.freeze([]) }),
      }),
    });
    const presented = adaptPlanningWorkspace(workspace);
    expect(presented.projects[0]).toMatchObject({ name: "Release readiness", stateLabel: "awaiting scope approval" });
    expect(presented.selected).toMatchObject({ budgetLabel: "£1,250.50", repositoryLabel: "No repository selected" });
    expect(workspace.authority).toBe("none");
  });

  it("gives distinct recovery copy for unknown outcomes and stale conflicts", () => {
    const result = (kind: PlanningCommandResult["kind"]): PlanningCommandResult => Object.freeze({
      kind,
      commandId: "6da16806-51e6-4f88-bb07-79822726cda1",
      reason: null,
      projectId: "project-1",
      workspace: null,
      projectionWarning: null,
    });
    expect(planningResultMessage(result("unknown"), "Scope approval")).toContain("Observe this exact command");
    expect(planningResultMessage(result("conflict"), "Plan draft")).toContain("Reload the saved project");
    expect(planningRecoveryDirective({ ...result("unknown"), commandId: "different-command" }, "submitted-command")).toEqual({ pendingCommandId: "submitted-command", reloadRequired: false });
    expect(planningRecoveryDirective({ ...result("unknown"), commandId: null }, null)).toEqual({ pendingCommandId: null, reloadRequired: true });
    expect(planningRecoveryDirective(result("conflict"), null)).toEqual({ pendingCommandId: null, reloadRequired: true });
    for (const projectionWarning of ["workspace-corrupt", "workspace-unavailable"] as const) {
      const known = { ...result("committed"), projectionWarning };
      expect(planningResultMessage(known, "Stop project")).toContain("Stop project saved.");
      expect(planningResultMessage(known, "Stop project")).toContain("outcome is confirmed");
      expect(planningRecoveryDirective(known, "submitted-command")).toEqual({ pendingCommandId: null, reloadRequired: true });
    }
    const fileWarning = { ...result("committed"), projectionWarning: "handover-files" as const };
    expect(planningResultMessage(fileWarning, "Stop project")).toContain("Saved work remains accessible");
    expect(planningRecoveryDirective(fileWarning, "submitted-command")).toEqual({ pendingCommandId: null, reloadRequired: false });
    expect(planningRecoveryDirective(result("corrupt"), "submitted-command")).toEqual({ pendingCommandId: "submitted-command", reloadRequired: true });
    expect(shortDigest("0123456789abcdefghijklmnop")).toBe("0123456789…klmnop");
    expect(formatMinorUnits(1_905, "GBP")).toBe("£19.05");
  });
});
