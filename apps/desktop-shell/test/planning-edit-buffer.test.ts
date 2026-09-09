import { describe, expect, it } from "vitest";
import { PlanningEditBuffer, planningDraftContent } from "../src/renderer/planning-edit-buffer.js";

describe("planning edits across status and saved-result updates", () => {
  it("keeps later typing when an earlier save result or provider status arrives", () => {
    const edits = new PlanningEditBuffer();
    expect(edits.read("project-a:session-1", "objective", "Saved objective")).toBe("Saved objective");
    edits.edit("project-a:session-1", "objective", "First submitted revision");
    edits.edit("project-a:session-1", "objective", "Still typing after submit");
    expect(edits.read("project-a:session-1", "objective", "First submitted revision")).toBe("Still typing after submit");
    expect(edits.hasUnsaved("project-a:session-1")).toBe(true);
    expect(edits.read("project-a:session-1", "objective", "Still typing after submit")).toBe("Still typing after submit");
    expect(edits.hasUnsaved("project-a:session-1")).toBe(false);
  });

  it("isolates projects and new sessions and does not replace edits with a stale saved view", () => {
    const edits = new PlanningEditBuffer();
    edits.edit("project-a:session-1", "answer-1", "Operator answer");
    expect(edits.read("project-a:session-1", "answer-1", "")).toBe("Operator answer");
    expect(edits.read("project-b:session-1", "answer-1", "Other project")).toBe("Other project");
    expect(edits.read("project-a:session-2", "answer-1", "New session")).toBe("New session");
    expect(edits.hasUnsaved("project-a:session-1")).toBe(true);
  });

  it("recognizes persisted field order as the same exact draft but detects a changed answer", () => {
    const submitted = { description: "Journal", answers: [{ questionId: "audience", value: "Gardeners" }] };
    const reopened = { answers: [{ value: "Gardeners", questionId: "audience" }], description: "Journal" };
    expect(planningDraftContent(submitted)).toBe(planningDraftContent(reopened));
    expect(planningDraftContent(submitted)).not.toBe(planningDraftContent({ ...reopened, answers: [{ value: "Clinicians", questionId: "audience" }] }));
  });
});
