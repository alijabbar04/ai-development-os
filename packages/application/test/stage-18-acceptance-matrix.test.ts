import { createHash } from "node:crypto";
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
  readonly stage20AEligible: boolean;
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
      "stage20AEligible",
    ]);
    expect(matrix).toMatchObject({
      schemaVersion: 1,
      branch: "feat/stage-18-development-acceptance-closure",
      productionAdmitted: false,
      developmentAccepted: true,
      stage20AEligible: true,
    });
    expect(matrix.sourceBase).toBe(
      "f90a779fce8c14cb6c4c3166ed89b0af5355b660",
    );
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
    expect(byId.get("ANT-02")?.status).toBe("proven");
    expect(byId.get("AM-02")?.status).toBe("proven");
    expect(byId.get("PLN-02")?.status).toBe("incomplete");
    expect(byId.get("INT-01")?.status).toBe("proven");
    expect(byId.get("PRD-01")?.status).toBe("production-gated");
    // ANT-02 and AM-02 are both proven on this closure candidate. Pinning the
    // empty set prevents narrative text from quietly overriding a regressed
    // development-blocking row.
    expect(
      matrix.rows
        .filter((row) => row.blocksDevelopmentAcceptance && row.status !== "proven")
        .map((row) => row.id),
    ).toEqual([]);
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
    expect(matrix.stage20AEligible).toBe(matrix.developmentAccepted);
    const expectedOutcome = checkpointIncomplete
      ? "Checkpoint incomplete"
      : developmentIncomplete
        ? "Stage 18D production-disabled checkpoint complete"
        : "Stage 18 development scope complete; production admission gated on Stage 17W";
    expect(matrix.permittedOutcome).toBe(expectedOutcome);
    expect(matrix.productionAdmitted).toBe(false);
    expect(matrix.rows.some((row) => row.status === "production-gated" && row.blocksProduction)).toBe(true);
  });

  it("binds ANT-02 promotion to the exact committed receipt and closure record", () => {
    const receiptPath = resolve(
      repositoryRoot,
      "docs",
      "release-evidence",
      "stage-18-ant-02-fresh-validation-receipt.json",
    );
    const closurePath = resolve(
      repositoryRoot,
      "docs",
      "release-evidence",
      "stage-18-ant-02-development-acceptance-closure.json",
    );
    const receiptText = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as Record<string, unknown>;
    const closure = JSON.parse(readFileSync(closurePath, "utf8")) as Readonly<{
      reviewedCandidate: Readonly<{ head: string; tree: string; manifestAggregate: string }>;
      authorization: Readonly<{ packetSha256: string; markerNamespaceSha256: string; retryPolicy: string }>;
      operation: Readonly<{ credentialResolutionCount: number; credentialDisclosedOutsideAuthorizedProviderAuthentication: boolean; dispatchCount: number; retryCount: number; outcome: string; resultCode: string; productionEnabled: boolean }>;
      receipt: Readonly<{ relativePath: string; receiptId: string; bytes: number; sha256: string; fieldCount: number; namedProjectionCount: number; validatorVerdict: string }>;
      acceptance: Readonly<{ "AM-02": string; "INT-01": string; "ANT-02": string; "PLN-02": string; developmentAccepted: boolean; productionAdmitted: boolean; stage20AEligible: boolean; stage20AStarted: boolean }>;
    }>;
    const receiptSha256 = createHash("sha256").update(receiptText, "utf8").digest("hex");
    expect(Buffer.byteLength(receiptText, "utf8")).toBe(1_707);
    expect(receiptSha256).toBe("9f5083f92b5616fd9b34d28d9dd75b333514c9e74b9bc15914d4c27ae4ffe0b4");
    expect(receiptText.endsWith("\n")).toBe(true);
    expect(receiptText).not.toMatch(/sk-ant-|x-api-key|authorization:\s*bearer/iu);
    expect(keys(receipt)).toEqual([
      "apiVersion", "attemptLimit", "authorizationPacketSha256",
      "authorizationReference", "authorizationRetentionMode", "authorizationState",
      "candidateHead", "candidateManifestAggregate", "candidateTree", "completedAt",
      "credentialRetained", "digestConvention", "dispatchCount", "durationMs", "endpoint",
      "fixedRequestBody", "inputTokens", "markerNamespaceSha256", "modelId",
      "modelSubstitutionRejected", "operationId", "operationVersion", "outputTokens",
      "policyDecisionFingerprint", "providerInstanceId", "receiptVersion",
      "repositorySourcePresent", "requestFingerprint", "responseBodyRetained",
      "resultSchemaVersion", "retentionMode", "retryPolicy", "schemaVersion", "slotId",
      "startedAt", "statusCategory", "terminalState", "transportKind",
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      candidateHead: "f90a779fce8c14cb6c4c3166ed89b0af5355b660",
      candidateTree: "f4a0035c03150970f700435af64cd2bd4e0968e4",
      candidateManifestAggregate: "0cb4729cc4211dca11ef1f166ccd4340ad82db4ba50310c6b5e97244fcbd1d66",
      authorizationPacketSha256: "4a83dbdf2bbbae2767d15872fc744f1bbfc155326b1f1e2a34077619d17c0d72",
      markerNamespaceSha256: "93a926d5775a953e724c93f88e5bbe82587dd3c64e8620a0d63757e8d191f467",
      requestFingerprint: "0982d0a5d19ff6bf01bc87a40b96da6a33e84bccd294846ea7ecf1ccd2d7a13a",
      dispatchCount: 1,
      retryPolicy: "none",
      statusCategory: "success",
      terminalState: "validated-success",
      credentialRetained: false,
      responseBodyRetained: false,
    });
    expect(closure.reviewedCandidate).toMatchObject({
      head: receipt["candidateHead"],
      tree: receipt["candidateTree"],
      manifestAggregate: receipt["candidateManifestAggregate"],
    });
    expect(closure.authorization).toMatchObject({
      packetSha256: receipt["authorizationPacketSha256"],
      markerNamespaceSha256: receipt["markerNamespaceSha256"],
      retryPolicy: "none",
    });
    expect(closure.operation).toMatchObject({
      credentialResolutionCount: 1,
      credentialDisclosedOutsideAuthorizedProviderAuthentication: false,
      dispatchCount: 1,
      retryCount: 0,
      outcome: "valid",
      resultCode: "VALIDATION_OK",
      productionEnabled: false,
    });
    expect(closure.receipt).toMatchObject({
      relativePath: "docs/release-evidence/stage-18-ant-02-fresh-validation-receipt.json",
      receiptId: receipt["authorizationPacketSha256"],
      bytes: 1_707,
      sha256: receiptSha256,
      fieldCount: 38,
      namedProjectionCount: 1,
      validatorVerdict: "ANT02_PROVEN",
    });
    expect(closure.acceptance).toEqual({
      "AM-02": "proven",
      "INT-01": "proven",
      "ANT-02": "proven",
      "PLN-02": "incomplete",
      developmentAccepted: true,
      productionAdmitted: false,
      stage20AEligible: true,
      stage20AStarted: false,
    });
    const anthropic = matrix.rows.find((row) => row.id === "ANT-02");
    expect(anthropic?.status).toBe("proven");
    expect(anthropic?.evidence).toContain(
      "docs/release-evidence/stage-18-ant-02-fresh-validation-receipt.json",
    );
    expect(matrix.developmentAccepted).toBe(true);
    expect(matrix.stage20AEligible).toBe(true);
    expect(matrix.productionAdmitted).toBe(false);
  });
});
