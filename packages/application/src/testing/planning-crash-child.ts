import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createSavedPlanningApplication } from "../planning.js";
import { openPlanningStorage } from "../planning-storage.js";
import type { PlanningCommand, PlanningProjectView } from "../planning-contracts.js";
import type { TransactionContext } from "@ai-dev-os/persistence";

const root = process.argv[2]!, mode = process.argv[3];
if (!isAbsolute(root) || !basename(root).startsWith("saved-planning-crash-") || !["before-commit", "after-commit"].includes(mode ?? "") || typeof process.send !== "function") throw new Error("CRASH_FIXTURE_ARGUMENTS");
const storage = await openPlanningStorage(join(root, "saved"));
let armed = false;
const hold = async (kind: string): Promise<never> => { process.send!({ kind }); return await new Promise<never>(() => undefined); };
const persistence = { ...storage.persistence, async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
  let seal = false;
  const result = await storage.persistence.transact((base) => work({ ...base, events: { ...base.events, async append(input) {
    const event = await base.events.append(input);
    if (armed && input.eventType === "plan.sealed") { seal = true; if (mode === "before-commit") await hold("uncommitted-seal-journal"); }
    return event;
  } } }));
  if (seal && mode === "after-commit") await hold("committed-reply-lost");
  return result;
} };
const app = createSavedPlanningApplication({ persistence, artifactRoot: storage.artifactRoot, operator: { confirm: async () => true, selectRepository: async () => join(root, "repository"), selectResult: async () => null } });
await app.initialize();
async function command(value: PlanningCommand): Promise<PlanningProjectView> {
  const result = await app.command(value); if (result.kind !== "committed") throw new Error(`CRASH_FIXTURE_${result.kind}`); return result.workspace!.selected!;
}
let p = await command({ kind: "create-project", commandId: "crash:create", name: "Crash recovery journal", objective: "Keep a local plan", outcomes: ["Reopen a saved plan"], budgetMinorUnits: 0, currency: "GBP" });
p = await command({ kind: "accept-brief", commandId: "crash:brief", projectId: p.projectId, candidateId: p.candidate!.candidateId, candidateDigest: p.candidate!.digest, expectedBriefVersion: 0 });
p = await command({ kind: "save-plan", commandId: "crash:draft", projectId: p.projectId, expectedPlanVersion: 0, title: "Crash-safe manual plan", scope: "scope-expansion", tasks: [{ title: "Additional report", objective: "Review a local report", acceptanceCriteria: ["The report scope is explicitly approved"] }] });
p = await command({ kind: "prepare-plan", commandId: "crash:prepare", projectId: p.projectId, expectedPlanVersion: p.plan!.version });
await writeFile(join(root, "baseline.json"), JSON.stringify(p), { flag: "wx" });
armed = true;
await command({ kind: "approve-scope", commandId: "crash:seal", projectId: p.projectId, expectedPlanVersion: p.plan!.version, scopeRequest: p.plan!.scopeApproval!.subject });
throw new Error("CRASH_FAULT_NOT_REACHED");
