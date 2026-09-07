import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKSPACE_EXAMPLE } from "../src/examples/workspace-example.js";

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
});
