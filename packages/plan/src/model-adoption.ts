import { serializeCanonicalProjectJson } from "@ai-dev-os/project";
import type {
  ClaimProvenance,
  PlanDigestPort,
  PlanModelEditRecord,
  PlanModelFieldEdit,
  PlanProposal,
  PreparedModelPlanAdoption,
  ProposedStage,
  ProposedTask,
} from "./contracts.js";
import { refusePlan } from "./errors.js";
import {
  exactKeys,
  parseAuthenticatedOperatorEvidence,
  parsePlanProposal,
  planDigest,
  strictRecord,
} from "./validation.js";

type ProposalNode = ProposedStage | ProposedTask;

function fieldValue(node: ProposalNode, path: string): string | null {
  if (path === "title") return node.title;
  if ("intent" in node) {
    if (path === "intent") return node.intent;
    const match = /^exitCriteria\[(0|[1-9]\d*)\]$/u.exec(path);
    return match === null ? null : node.exitCriteria[Number(match[1])] ?? null;
  }
  if (path === "objective") return node.objective;
  const match = /^acceptance\[(0|[1-9]\d*)\]\.criterion$/u.exec(path);
  return match === null ? null : node.acceptance[Number(match[1])]?.criterion ?? null;
}

function findNode(proposal: PlanProposal, edit: PlanModelFieldEdit): ProposalNode {
  const node = edit.nodeKind === "stage"
    ? proposal.stages.find((row) => row.stageId === edit.nodeId)
    : proposal.tasks.find((row) => row.taskId === edit.nodeId);
  if (node === undefined || fieldValue(node, edit.fieldPath) === null || node.provenance[edit.fieldPath] === undefined) {
    return refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.operator-claim-unbacked", "planProposal");
  }
  return node;
}

function replaceField(node: ProposalNode, path: string, value: string, provenance: ClaimProvenance): ProposalNode {
  const fields = Object.freeze({ ...node.provenance, [path]: provenance });
  if (path === "title") return Object.freeze({ ...node, title: value, provenance: fields });
  if ("intent" in node) {
    if (path === "intent") return Object.freeze({ ...node, intent: value, provenance: fields });
    const index = Number(/^exitCriteria\[(\d+)\]$/u.exec(path)![1]);
    return Object.freeze({ ...node, exitCriteria: Object.freeze(node.exitCriteria.map((entry, at) => at === index ? value : entry)), provenance: fields });
  }
  if (path === "objective") return Object.freeze({ ...node, objective: value, provenance: fields });
  const index = Number(/^acceptance\[(\d+)\]\.criterion$/u.exec(path)![1]);
  return Object.freeze({ ...node, acceptance: Object.freeze(node.acceptance.map((entry, at) => at === index ? Object.freeze({ ...entry, criterion: value }) : entry)), provenance: fields });
}

function replaceClaim(proposal: PlanProposal, edit: PlanModelFieldEdit, value: string, provenance: ClaimProvenance): PlanProposal {
  findNode(proposal, edit);
  return Object.freeze({
    ...proposal,
    stages: Object.freeze(proposal.stages.map((node) => edit.nodeKind === "stage" && node.stageId === edit.nodeId ? replaceField(node, edit.fieldPath, value, provenance) as ProposedStage : node)),
    tasks: Object.freeze(proposal.tasks.map((node) => edit.nodeKind === "task" && node.taskId === edit.nodeId ? replaceField(node, edit.fieldPath, value, provenance) as ProposedTask : node)),
  });
}

/** The digest identifies the exact, unedited C9 model proposal, not its acceptance. */
export function computeModelPlanProposalDigest(value: unknown, digest: PlanDigestPort): string {
  const proposal = parsePlanProposal(value);
  if (proposal.source.kind !== "model" || proposal.source.adoption !== undefined) {
    return refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.provenance.model-claims-derivation", "planProposal");
  }
  let computed: unknown;
  try { computed = digest.sha256(serializeCanonicalProjectJson(proposal)); }
  catch { return refusePlan("PLAN_VALIDATION_REFUSED", "plan.proposal.digest-mismatch", "planProposal"); }
  return planDigest(computed, "planProposal");
}

/** Reconstruct the immutable source on assembly and durable reopen; edits cannot rewrite its identity. */
export function assertModelPlanAdoptionCoherent(proposal: PlanProposal, digest: PlanDigestPort): PlanProposal | null {
  if (proposal.source.kind !== "model" || proposal.source.adoption === undefined) return null;
  const { adoption, ...source } = proposal.source;
  let original: PlanProposal = Object.freeze({ ...proposal, source });
  for (const edit of adoption.edits) original = replaceClaim(original, edit, edit.previousValue, edit.previousProvenance);
  if (computeModelPlanProposalDigest(original, digest) !== adoption.originalProposalDigest) {
    refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.proposal.digest-mismatch", "planProposal");
  }
  return original;
}

/**
 * Pure host preparation after exact model-artifact lookup and native review.
 * It issues no capability: every returned edit row must separately be present
 * in the trusted host's private PlanCommitAuthorization facts before a write.
 * Caller/model text cannot change graph, budget, coverage, source or authority.
 */
export function prepareModelPlanAdoption(input: Readonly<{
  proposal: unknown;
  expectedModelProposalDigest: string;
  edits: readonly PlanModelFieldEdit[];
}>, digest: PlanDigestPort): PreparedModelPlanAdoption {
  const value = strictRecord(input, "planProposal");
  exactKeys(value, ["proposal", "expectedModelProposalDigest", "edits"], "planProposal", "plan.proposal.unknown-field");
  const proposal = parsePlanProposal(value["proposal"]);
  const originalProposalDigest = computeModelPlanProposalDigest(proposal, digest);
  if (originalProposalDigest !== planDigest(value["expectedModelProposalDigest"], "planProposal")) {
    return refusePlan("PLAN_AUTHORITY_VIOLATION", "plan.proposal.digest-mismatch", "planProposal");
  }
  const edits = parseAuthenticatedOperatorEvidence(value["edits"]);
  const history: PlanModelEditRecord[] = [];
  let edited = proposal;
  for (const edit of edits) {
    const node = findNode(proposal, edit), previousValue = fieldValue(node, edit.fieldPath)!;
    if (previousValue === edit.value) return refusePlan("PLAN_PROVENANCE_REFUSED", "plan.provenance.operator-claim-unbacked", "planProposal");
    history.push(Object.freeze({ ...edit, previousValue, previousProvenance: node.provenance[edit.fieldPath]! }));
    edited = replaceClaim(edited, edit, edit.value, Object.freeze({ origin: "operator-edit", derivedFrom: null, verbatim: true }));
  }
  const result = parsePlanProposal({ ...edited, source: { ...proposal.source, adoption: { schemaVersion: 1, originalProposalDigest, edits: history } } });
  assertModelPlanAdoptionCoherent(result, digest);
  return Object.freeze({ proposal: result, authenticatedOperatorEvidence: edits });
}
