import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { TransactionContext } from "@ai-dev-os/persistence";
import { createSavedPlanningApplication } from "../planning.js";
import { openPlanningStorage } from "../planning-storage.js";
import type { PlanningCommand } from "../planning-contracts.js";
import { createOwnedAiTestPort } from "./planning-ai-fixture.js";

const root = process.argv[2]!, mode = process.argv[3];
if (!isAbsolute(root) || !basename(root).startsWith("ai-planning-crash-") || !["after-admission", "after-dispatch", "before-terminal", "after-terminal"].includes(mode ?? "") || typeof process.send !== "function") throw new Error("OWNED_AI_CRASH_ARGUMENTS");
const store = await openPlanningStorage(join(root, "saved"));
const hold = async (kind: string): Promise<never> => { process.send!({ kind }); return new Promise<never>(() => undefined); };
const persistence = { ...store.persistence, async transact<T>(work: (tx: TransactionContext) => Promise<T> | T): Promise<T> {
  let terminal = false, admission = false;
  const value = await store.persistence.transact((tx) => work({ ...tx, events: { ...tx.events, async append(input) {
    const event = await tx.events.append(input);
    if (input.eventType === "planning-command.completed" && input.causationId === "crash:ai-request") admission = true;
    if (input.eventType === "ai.request-terminal") { terminal = true; if (mode === "before-terminal") await hold(mode); }
    return event;
  } } }));
  if (admission && mode === "after-admission" || terminal && mode === "after-terminal") await hold(mode!);
  return value;
} };
const port = createOwnedAiTestPort({ execute: async (_input, result) => { if (mode === "after-dispatch") return hold(mode); return result; } });
const app = createSavedPlanningApplication({ persistence, artifactRoot: store.artifactRoot, planningProcess: port.host, operator: { confirm: async () => true, selectRepository: async () => join(root, "repository"), selectResult: async () => null } });
await app.initialize();
async function command(value: PlanningCommand) { const result = await app.command(value); if (result.kind !== "committed" || result.workspace?.selected === null) throw new Error(`OWNED_AI_CRASH_${JSON.stringify(result)}`); return result.workspace!.selected!; }
let p = await command({ kind: "create-project", commandId: "crash:ai-create", name: "Owned AI crash fixture", objective: "Keep field observations", outcomes: ["Reopen saved observations"], budgetMinorUnits: 0, currency: "GBP" });
p = await command({ kind: "start-ai-planning", commandId: "crash:ai-start", projectId: p.projectId, expectedSessionVersion: 0, description: "Keep field observations", includeRepositorySummary: false });
await writeFile(join(root, "baseline.json"), JSON.stringify({ projectId: p.projectId, sessionId: p.aiPlanning.currentSession!.sessionId }), { flag: "wx" });
await command({ kind: "request-ai-understanding", commandId: "crash:ai-request", projectId: p.projectId, sessionId: p.aiPlanning.currentSession!.sessionId, expectedSessionVersion: p.aiPlanning.version, contextDigest: p.aiPlanning.contextDigest });
// Keep this owned fixture alive until the exact phase marker is killed. The
// parent test has the finite deadline and owns this process, store and root.
setInterval(() => undefined, 1000);
