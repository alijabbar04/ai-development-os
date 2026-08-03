import type { ChangedFileEntry, ChangedFileManifest } from "@ai-dev-os/workspace";
import { prefixCovers, type CapabilityGrant } from "@ai-dev-os/process-broker";
import type { ChangedFileSummary, FileChangeKind } from "@ai-dev-os/providers";
import type { CodexDetailCode } from "./errors.js";
import type { CodexWorkspaceHandle } from "./ports.js";

const ADMIN = new Set([".git", ".hg", ".svn", ".ai-dev-os"]);
export interface CodexReconciliationViolation { readonly detailCode: CodexDetailCode; readonly count: number }
export interface CodexReconciliationResult {
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly totalProducedBytes: number;
  readonly violations: readonly CodexReconciliationViolation[];
  readonly clean: boolean;
  readonly unavailable: boolean;
}
function neutral(kind: ChangedFileEntry["changeKind"]): FileChangeKind {
  switch (kind) {
    case "added": case "copied": return "added";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
    default: return "modified";
  }
}
function hostile(path: string): boolean {
  return path.length === 0 || path.length > 1_024 || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}
function administrative(path: string): boolean { return path.split("/").some((part) => ADMIN.has(part.normalize("NFC").toLowerCase())); }

export async function reconcileCodexWorkspace(input: {
  readonly workspace: CodexWorkspaceHandle;
  readonly grant: CapabilityGrant;
  readonly allowedPathPrefixes: readonly string[];
  readonly maxChangedFiles: number;
  readonly maxProducedBytes: number;
  readonly editingGranted: boolean;
}): Promise<CodexReconciliationResult> {
  let manifest: ChangedFileManifest;
  try { manifest = await input.workspace.captureChanges(); }
  catch { return Object.freeze({ changedFiles: Object.freeze([]), totalProducedBytes: 0, violations: Object.freeze([Object.freeze({ detailCode: "workspace-missing" as const, count: 1 })]), clean: false, unavailable: true }); }
  const counts = new Map<CodexDetailCode, number>(); const bump = (code: CodexDetailCode) => counts.set(code, (counts.get(code) ?? 0) + 1);
  const accepted: ChangedFileSummary[] = []; let totalProducedBytes = 0;
  for (const entry of manifest.entries) {
    const path = entry.path;
    if (hostile(path) || (entry.previousPath !== null && hostile(entry.previousPath))) { bump("reconciliation-path-violation"); continue; }
    if (administrative(path) || (entry.previousPath !== null && administrative(entry.previousPath))) { bump("reconciliation-administrative-path"); continue; }
    if (!input.editingGranted || (input.allowedPathPrefixes.length > 0 && !prefixCovers(input.allowedPathPrefixes, path)) || !prefixCovers(input.grant.writablePrefixes, path)) { bump("reconciliation-path-violation"); continue; }
    if (entry.isSymlink) { bump("reconciliation-link-escape"); continue; }
    if (entry.changeKind !== "deleted") {
      try { if ((await input.workspace.linkMetadata(path)).isLink) { bump("reconciliation-link-escape"); continue; } }
      catch { bump("reconciliation-link-escape"); continue; }
    }
    totalProducedBytes += entry.sizeBytes ?? 0;
    accepted.push(Object.freeze({ path, changeKind: neutral(entry.changeKind) }));
  }
  if (accepted.length > input.maxChangedFiles || manifest.truncated) bump("reconciliation-file-limit");
  if (totalProducedBytes > input.maxProducedBytes) bump("reconciliation-byte-limit");
  const violations = Object.freeze([...counts.entries()].map(([detailCode, count]) => Object.freeze({ detailCode, count })).sort((a, b) => a.detailCode.localeCompare(b.detailCode)));
  return Object.freeze({ changedFiles: Object.freeze(accepted.sort((a, b) => a.path.localeCompare(b.path))), totalProducedBytes, violations, clean: violations.length === 0, unavailable: false });
}
