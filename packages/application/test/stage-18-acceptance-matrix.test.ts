import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const matrixPath = resolve(
  repositoryRoot,
  "docs",
  "release-evidence",
  "stage-18-development-acceptance-matrix.json",
);

interface MatrixRow {
  readonly id: string;
  readonly requirement: string;
  readonly authority: readonly string[];
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
  readonly evidence: readonly string[];
  readonly status: "proven" | "production-gated" | "incomplete";
  readonly ownerStage: string;
  readonly blocksDevelopmentAcceptance: boolean;
  readonly blocksProduction: boolean;
  readonly rationale: string;
}

interface Matrix {
  readonly schemaVersion: number;
  readonly branch: string;
  readonly sourceBase: string;
  readonly productionAdmitted: boolean;
  readonly developmentAccepted: boolean;
  readonly permittedOutcome: string;
  readonly checkpointRows: readonly string[];
  readonly rows: readonly MatrixRow[];
}

function keys(value: object): readonly string[] {
  return Object.keys(value).sort();
}

function localPath(anchor: string): string {
  return resolve(repositoryRoot, anchor.split("#", 1)[0] as string);
}

describe("machine-checkable Stage 18 development acceptance matrix", () => {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Matrix;

  it("has one strict versioned non-production envelope", () => {
    expect(keys(matrix)).toEqual([
      "branch",
      "checkpointRows",
      "developmentAccepted",
      "permittedOutcome",
      "productionAdmitted",
      "rows",
      "schemaVersion",
      "sourceBase",
    ]);
    expect(matrix).toMatchObject({
      schemaVersion: 1,
      branch: "feat/stage-18d-postgres-admission-readiness",
      productionAdmitted: false,
    });
    expect(matrix.sourceBase).toMatch(/^[a-f0-9]{40}$/);
    expect(matrix.rows.length).toBeGreaterThanOrEqual(15);
  });

  it("rejects narrative-only passes, duplicate rules, and stale local anchors", () => {
    const ids = new Set<string>();
    for (const row of matrix.rows) {
      expect(keys(row)).toEqual([
        "authority",
        "blocksDevelopmentAcceptance",
        "blocksProduction",
        "evidence",
        "id",
        "implementation",
        "ownerStage",
        "rationale",
        "requirement",
        "status",
        "tests",
      ]);
      expect(row.id).toMatch(/^[A-Z]{2,3}-[0-9]{2}$/);
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
      expect(row.requirement.length).toBeGreaterThan(20);
      expect(row.rationale.length).toBeGreaterThan(20);
      expect(row.authority.length).toBeGreaterThan(0);
      expect(["proven", "production-gated", "incomplete"]).toContain(row.status);
      expect(row.ownerStage).toMatch(/^[0-9]{2}[A-Z]?$/);
      if (row.status !== "incomplete") {
        expect(row.implementation.length).toBeGreaterThan(0);
        expect(row.tests.length).toBeGreaterThan(0);
        expect(row.evidence.length).toBeGreaterThan(0);
      }
      for (const anchor of [
        ...row.authority,
        ...row.implementation,
        ...row.tests,
        ...row.evidence,
      ]) {
        expect(anchor).not.toMatch(/^https?:/);
        expect(existsSync(localPath(anchor)), `${row.id}: missing ${anchor}`).toBe(true);
      }
    }
    expect(ids.size).toBe(matrix.rows.length);
  });

  it("derives the only permitted outcome instead of trusting prose", () => {
    const byId = new Map(matrix.rows.map((row) => [row.id, row]));
    expect(new Set(matrix.checkpointRows).size).toBe(matrix.checkpointRows.length);
    const checkpointIncomplete = matrix.checkpointRows.some((id) => {
      const row = byId.get(id);
      expect(row?.ownerStage).toBe("18D");
      return row?.status !== "proven";
    });
    const developmentIncomplete = matrix.rows.some(
      (row) => row.blocksDevelopmentAcceptance && row.status === "incomplete",
    );
    expect(matrix.developmentAccepted).toBe(!developmentIncomplete);
    const expectedOutcome = checkpointIncomplete
      ? "Checkpoint incomplete"
      : developmentIncomplete
        ? "Stage 18D production-disabled checkpoint complete"
        : "Stage 18 development scope complete; production admission gated on Stage 17W";
    expect(matrix.permittedOutcome).toBe(expectedOutcome);
    expect(matrix.productionAdmitted).toBe(false);
    expect(matrix.rows.some((row) => row.status === "production-gated" && row.blocksProduction)).toBe(true);
  });
});
