import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  backendDescriptorFingerprint,
  createControlPlaneEndpointPolicy,
  createEnforcementAttestation,
  createExecutionLease,
  createProcessBroker,
  createProcessQuotas,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  evaluateFinalAdmission,
  evaluateGrantContainment,
  grantFingerprint,
  noQuotaSupport,
  parseBackendDescriptor,
  parseControlPlaneEndpointPolicy,
  parseEnforcementAttestation,
  projectEnforcementAttestation,
  projectVerifiedProductionRegistration,
  systemClock,
  type BackendDescriptor,
  type EnforcementAttestation,
  type SandboxBackend,
} from "../src/index.js";
import {
  issueProductionBackendRegistration,
  issueProductionSessionReceipt,
  invalidateProductionBackendRegistration,
  sandboxSessionFingerprint,
  verifyAndConsumeProductionSessionReceipt,
  verifyProductionBackendRegistration,
  type ProductionBackendRegistration,
} from "../src/trusted-evidence.js";
import {
  SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT,
  SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
  SECURE_BACKEND_ESCAPE_VECTORS,
  secureBackendEscapeVectorCount,
} from "../src/escape-corpus.js";
import { contractGrant, contractRequest } from "../src/testing/contract-suite.js";
import { allowAllPolicy, fixtureTool } from "./contract.test.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function secureDescriptor(
  overrides: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  return parseBackendDescriptor({
    schemaVersion: 2,
    backendId: "secure-test",
    kind: "container",
    platform: process.platform,
    securityClass: "secure-enforcing",
    capabilities: {
      filesystemIsolation: true,
      processTreeControl: true,
      networkBoundary: "deny-all",
      identityIsolation: true,
      profileIsolation: true,
      quotas: noQuotaSupport({
        "wall-clock": "enforced",
        "output-bytes": "enforced",
        network: "enforced",
      }),
    },
    versionEvidence: "test-v1",
    ...overrides,
  });
}

function backendFor(descriptor: BackendDescriptor): SandboxBackend {
  return {
    describe: () => descriptor,
    probe: async () => ({ available: true, reason: "available", detail: null }),
    validateGrant: () => ({ available: true, reason: "available", detail: null }),
    prepare: async () => {
      throw new Error("not exercised");
    },
    spawn: async () => {
      throw new Error("not exercised");
    },
    dispose: async () => undefined,
    close: async () => undefined,
  };
}

function attestationFor(
  descriptor: BackendDescriptor,
  options: {
    readonly observedAt?: string;
    readonly expiresAt?: string;
    readonly helperBound?: boolean;
    readonly corpusResult?: "passed" | "failed" | "not-run";
    readonly controlledEgress?: "enforced" | "unverified";
    readonly endpointPolicyFingerprint?: string | null;
    readonly corpusVersion?: number;
    readonly corpusFingerprint?: string;
    readonly corpusTestCount?: number;
  } = {},
): EnforcementAttestation {
  const now = systemClock.now().valueOf();
  const corpusResult = options.corpusResult ?? "passed";
  const helperBound = options.helperBound ?? true;
  return createEnforcementAttestation({
    schemaVersion: 1,
    algorithmVersion: 1,
    backendId: descriptor.backendId,
    backendFactoryId: "test-first-party-v1",
    enforcementProfile: "test-complete-v1",
    descriptorFingerprint: backendDescriptorFingerprint(descriptor),
    platform: {
      os: process.platform as "win32" | "linux" | "darwin",
      version: "test-1",
      kernel: "test-1",
      architecture: process.arch as "x64" | "arm64",
      distribution: null,
    },
    helper: {
      protocolVersion: 1,
      sourceDigest: helperBound ? "1".repeat(64) : null,
      binaryDigest: helperBound ? "2".repeat(64) : null,
      buildDigest: helperBound ? "3".repeat(64) : null,
    },
    boundaries: {
      filesystem: "enforced",
      "process-tree": "enforced",
      identity: "enforced",
      profile: "enforced",
      "network-denial": "enforced",
      "controlled-egress": options.controlledEgress ?? "unverified",
      credentials: "enforced",
      ipc: "enforced",
      cleanup: "enforced",
    },
    quotas: descriptor.capabilities.quotas,
    endpointPolicyFingerprint: options.endpointPolicyFingerprint ?? null,
    escapeCorpus: {
      version: options.corpusVersion ?? SECURE_BACKEND_ESCAPE_CORPUS_VERSION,
      fingerprint:
        corpusResult === "not-run"
          ? null
          : (options.corpusFingerprint ?? SECURE_BACKEND_ESCAPE_CORPUS_FINGERPRINT),
      result: corpusResult,
      positiveControlsPassed: corpusResult === "passed",
      testCount:
        corpusResult === "not-run"
          ? 0
          : (options.corpusTestCount ??
            secureBackendEscapeVectorCount(process.platform as "win32" | "linux" | "darwin")),
    },
    observedAt: options.observedAt ?? new Date(now - 1_000).toISOString(),
    expiresAt: options.expiresAt ?? new Date(now + 60_000).toISOString(),
    limitations: [],
  });
}

function endpointPolicy() {
  return createControlPlaneEndpointPolicy({
    schemaVersion: 1,
    algorithmVersion: 1,
    policyId: "policy-test",
    providerInstanceId: "provider-test",
    adapterProfileId: "adapter-test",
    toolId: "echo",
    endpoints: [
      {
        scheme: "https",
        host: "api.example.invalid",
        port: 443,
        purpose: "codex-control",
      },
    ],
    dnsPolicyVersion: 1,
    maxRedirectHops: 2,
    allowHttp2: true,
    allowHttp3: false,
    observedAt: "2026-08-05T10:00:00.000Z",
    expiresAt: "2026-08-05T12:00:00.000Z",
  });
}

describe("Stage 17 body-free attestation contracts (non-enforcement)", () => {
  it("canonicalizes and fingerprints a complete summary", () => {
    const descriptor = secureDescriptor();
    const attestation = attestationFor(descriptor);
    expect(attestation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.boundaries)).toBe(true);
    expect(Object.isFrozen(SECURE_BACKEND_ESCAPE_VECTORS)).toBe(true);
    expect(SECURE_BACKEND_ESCAPE_VECTORS.every((vector) => Object.isFrozen(vector))).toBe(true);
    expect(
      SECURE_BACKEND_ESCAPE_VECTORS.every((vector) => Object.isFrozen(vector.platforms)),
    ).toBe(true);
    expect(parseEnforcementAttestation(attestation)).toEqual(attestation);
  });

  it("rejects fingerprint substitution and extra fields", () => {
    const attestation = attestationFor(secureDescriptor());
    expect(() =>
      parseEnforcementAttestation({ ...attestation, fingerprint: "f".repeat(64) }),
    ).toThrow(/fingerprint/);
    expect(() => parseEnforcementAttestation({ ...attestation, payload: "secret" })).toThrow();
  });

  it("rejects contradictory corpus claims and raw limitation text", () => {
    const attestation = attestationFor(secureDescriptor());
    expect(() =>
      parseEnforcementAttestation({
        ...attestation,
        escapeCorpus: {
          ...attestation.escapeCorpus,
          result: "passed",
          positiveControlsPassed: false,
        },
      }),
    ).toThrow(/positive controls/);
    expect(() =>
      parseEnforcementAttestation({
        ...attestation,
        limitations: ["C:\\private\\path leaked"],
      }),
    ).toThrow(/limitation/);
    expect(() =>
      parseEnforcementAttestation({
        ...attestation,
        observedAt: "2026-08-05T00:00:00.000Z",
        expiresAt: "2026-08-06T00:00:00.001Z",
      }),
    ).toThrow(/validity window/);
  });

  it("keeps incomplete summaries advisory and grants no routing authority", () => {
    const advisory = projectEnforcementAttestation(attestationFor(secureDescriptor()));
    expect(advisory).toMatchObject({ level: "advisory", grantsAuthority: false });
    const descriptor = secureDescriptor({
      capabilities: {
        ...secureDescriptor().capabilities,
        networkBoundary: "controlled-service-egress",
      },
    });
    const attestation = attestationFor(descriptor, {
        controlledEgress: "enforced",
        endpointPolicyFingerprint: "a".repeat(64),
      });
    expect(projectEnforcementAttestation(attestation)).toMatchObject({
      level: "advisory",
      grantsAuthority: false,
    });
    const backend = backendFor(descriptor);
    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation,
      purpose: "production",
    });
    expect(
      projectVerifiedProductionRegistration({
        registration,
        backend,
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: "a".repeat(64),
      }),
    ).toMatchObject({ level: "secure-enforcing", grantsAuthority: false });
    expect(
      projectVerifiedProductionRegistration({
        registration: { ...registration } as ProductionBackendRegistration,
        backend,
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: "a".repeat(64),
      }),
    ).toBeNull();
  });
});

describe("Stage 17 endpoint policy contracts (non-enforcement)", () => {
  it("accepts only an exact, expiring HTTPS destination set", () => {
    const policy = endpointPolicy();
    expect(policy.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.endpoints).toEqual([
      expect.objectContaining({ host: "api.example.invalid", port: 443, scheme: "https" }),
    ]);
    expect(parseControlPlaneEndpointPolicy(policy)).toEqual(policy);
    expect(() =>
      parseControlPlaneEndpointPolicy({
        ...policy,
        observedAt: "2026-08-05T00:00:00.000Z",
        expiresAt: "2026-08-06T00:00:00.001Z",
      }),
    ).toThrow(/validity window/);
  });

  it("sorts an exact multi-endpoint set deterministically", () => {
    const base = endpointPolicy();
    const { fingerprint: _fingerprint, ...unsigned } = base;
    const canonical = createControlPlaneEndpointPolicy({
      ...unsigned,
      endpoints: [
        {
          scheme: "https",
          host: "a.example.invalid",
          port: 443,
          purpose: "claude-code-control",
        },
        {
          scheme: "https",
          host: "z.example.invalid",
          port: 443,
          purpose: "codex-control",
        },
      ],
    });
    const policy = parseControlPlaneEndpointPolicy({
      ...canonical,
      endpoints: [...canonical.endpoints].reverse(),
    });
    expect(policy.endpoints.map((endpoint) => endpoint.host)).toEqual([
      "a.example.invalid",
      "z.example.invalid",
    ]);
  });

  it.each([
    "Example.invalid",
    "127.0.0.1",
    "localhost",
    "service.localhost",
    "service.local",
    "service.internal",
    "api.example.invalid.",
    "*.example.invalid",
    "tést.example",
  ])("rejects unsafe or non-canonical host %s", (host) => {
    const policy = endpointPolicy();
    expect(() =>
      parseControlPlaneEndpointPolicy({
        ...policy,
        endpoints: [{ ...policy.endpoints[0], host }],
      }),
    ).toThrow();
  });

  it("rejects alternate ports, QUIC, duplicates, empty policy, expiry, and tampering", () => {
    const policy = endpointPolicy();
    expect(() =>
      parseControlPlaneEndpointPolicy({
        ...policy,
        endpoints: [{ ...policy.endpoints[0], port: 8443 }],
      }),
    ).toThrow();
    expect(() => parseControlPlaneEndpointPolicy({ ...policy, allowHttp3: true })).toThrow(/QUIC/);
    expect(() =>
      parseControlPlaneEndpointPolicy({
        ...policy,
        endpoints: [policy.endpoints[0], policy.endpoints[0]],
      }),
    ).toThrow(/duplicates/);
    expect(() => parseControlPlaneEndpointPolicy({ ...policy, endpoints: [] })).toThrow(/empty/);
    expect(() =>
      parseControlPlaneEndpointPolicy({ ...policy, expiresAt: policy.observedAt }),
    ).toThrow(/expire/);
    expect(() =>
      parseControlPlaneEndpointPolicy({ ...policy, fingerprint: "f".repeat(64) }),
    ).toThrow(/fingerprint/);
  });
});

describe("Stage 17 grant monotonicity (non-enforcement)", () => {
  function baseline() {
    const grant = contractGrant({}, systemClock);
    const request = contractRequest(fixtureTool());
    const fp = grantFingerprint(grant);
    return {
      grant,
      grantFingerprint: fp,
      request,
      actualWorkingSubdirectory: request.workingSubdirectory ?? "",
      lease: {
        leaseId: request.workspaceLeaseId,
        grantId: grant.grantId,
        grantFingerprint: fp,
        workspaceId: grant.workspaceId,
        attemptId: grant.attemptId,
        state: "active" as const,
        expiresAt: grant.expiresAt,
        version: 1,
      },
      resolvedExecutableDigest: null,
      resolvedImmutableReference: null,
      controlPlaneEndpointPolicyFingerprint: null,
    };
  }

  it("accepts an exact bounded request", () => {
    expect(evaluateGrantContainment(baseline())).toEqual({ contained: true, reasons: [] });
  });

  it("detects identity, lease, policy, and approval widening", () => {
    const base = baseline();
    const mismatched = evaluateGrantContainment({
      ...base,
      request: {
        ...base.request,
        projectId: "other-project",
        workspaceId: "other-workspace",
        attemptId: "other-attempt",
        policyDecisionFingerprint: "f".repeat(64),
        approvalEvidenceRefs: ["ungranted-approval"],
        trace: { ...base.request.trace, runId: "other-run", taskId: "other-task" },
      },
      lease: { ...base.lease, leaseId: "other-lease", state: "revoked" },
    });
    expect(mismatched.reasons).toEqual(
      expect.arrayContaining([
        "project-mismatch",
        "workspace-mismatch",
        "attempt-mismatch",
        "run-mismatch",
        "task-mismatch",
        "lease-id-mismatch",
        "lease-inactive",
        "policy-grant-mismatch",
        "approval-evidence-widened",
      ]),
    );
  });

  it("detects tool, working-directory, environment, and credential widening", () => {
    const base = baseline();
    const narrowGrant = contractGrant(
      {
        readablePrefixes: ["src"],
        writablePrefixes: ["out"],
        tools: [{ toolId: "echo", digest: null, immutableReference: "image-a" }],
      },
      systemClock,
    );
    const narrowFingerprint = grantFingerprint(narrowGrant);
    const request = contractRequest(fixtureTool(), {
      workingSubdirectory: "outside",
      environment: [
        { kind: "secret", name: "UNGRANTED", secretRefFingerprint: "f".repeat(64) },
        { kind: "workspace-path", name: "CANARY", value: "outside" },
      ],
    });
    const decision = evaluateGrantContainment({
      ...base,
      grant: narrowGrant,
      grantFingerprint: narrowFingerprint,
      lease: {
        ...base.lease,
        grantFingerprint: narrowFingerprint,
      },
      request,
      resolvedExecutableDigest: "f".repeat(64),
    });
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "working-directory-outside-grant",
        "tool-not-granted",
        "environment-not-granted",
        "environment-path-outside-grant",
        "credential-not-granted",
      ]),
    );
  });

  it("treats denied as a subset, requires a network operation, and narrows allowlists", () => {
    const base = baseline();
    const allowGrant = contractGrant(
      {
        operations: [...base.grant.operations, "network-access"],
        network: { mode: "allowlist", egressDomains: ["a.example", "b.example"] },
      },
      systemClock,
    );
    const allowBase = {
      ...base,
      grant: allowGrant,
      grantFingerprint: grantFingerprint(allowGrant),
      lease: {
        ...base.lease,
        grantFingerprint: grantFingerprint(allowGrant),
      },
    };
    expect(
      evaluateGrantContainment({
        ...allowBase,
        request: contractRequest(fixtureTool(), {
          network: { mode: "allowlist", egressDomains: ["a.example"] },
        }),
      }).contained,
    ).toBe(true);
    expect(
      evaluateGrantContainment({
        ...allowBase,
        request: contractRequest(fixtureTool(), {
          network: { mode: "allowlist", egressDomains: ["c.example"] },
        }),
      }).reasons,
    ).toContain("network-widened");
    expect(
      evaluateGrantContainment({
        ...base,
        request: contractRequest(fixtureTool(), {
          network: { mode: "loopback-only", egressDomains: [] },
        }),
      }).reasons,
    ).toEqual(expect.arrayContaining(["network-operation-missing", "network-widened"]));
  });

  it("detects quota, output, deadline, and endpoint-policy widening", () => {
    const base = baseline();
    const widened = evaluateGrantContainment({
      ...base,
      request: contractRequest(fixtureTool(), {
        quotas: createProcessQuotas({
          wallClockMs: base.grant.quotas.wallClockMs + 1,
          outputBytes: base.grant.quotas.outputBytes,
          cpuTimeMs: 1,
        }),
        outputLimits: {
          maxStreamBytes: base.grant.quotas.outputBytes,
          maxCombinedBytes: base.grant.quotas.outputBytes,
          maxLineBytes: 1_024,
        },
        deadline: new Date(new Date(base.grant.expiresAt).valueOf() + 1).toISOString(),
      }),
      controlPlaneEndpointPolicyFingerprint: "a".repeat(64),
    });
    expect(widened.reasons).toEqual(
      expect.arrayContaining(["quota-widened", "deadline-widened", "endpoint-policy-mismatch"]),
    );
  });
});

describe("Stage 17 opaque production evidence (non-enforcement)", () => {
  it("rejects JSON-shaped registration forgery", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const forged = {
      attestation: attestationFor(descriptor),
      registrationFingerprint: "a".repeat(64),
    } as ProductionBackendRegistration;
    expect(
      verifyProductionBackendRegistration({
        registration: forged,
        backend,
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: null,
      }),
    ).toMatchObject({ verified: false, reason: "registration-forged" });
  });

  it("rejects test-only registration, backend substitution, and descriptor drift", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "test",
    });
    expect(
      verifyProductionBackendRegistration({
        registration,
        backend,
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: null,
      }).reason,
    ).toBe("registration-test-only");

    const production = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "production",
    });
    expect(
      verifyProductionBackendRegistration({
        registration: production,
        backend: backendFor(descriptor),
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: null,
      }).reason,
    ).toBe("registration-backend-mismatch");
    expect(
      verifyProductionBackendRegistration({
        registration: production,
        backend,
        descriptor: secureDescriptor({ versionEvidence: "drifted" }),
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: null,
      }).reason,
    ).toBe("descriptor-drift");
  });

  it("rejects stale, unbound-helper, incomplete-corpus, and endpoint-mismatched evidence", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const now = systemClock.now().valueOf();
    const cases: Array<{
      attestation: EnforcementAttestation;
      endpoint: string | null;
      reason: string;
    }> = [
      {
        attestation: attestationFor(descriptor, {
          observedAt: new Date(now - 2_000).toISOString(),
          expiresAt: new Date(now - 1_000).toISOString(),
        }),
        endpoint: null,
        reason: "attestation-stale",
      },
      {
        attestation: attestationFor(descriptor, { helperBound: false }),
        endpoint: null,
        reason: "attestation-helper-unbound",
      },
      {
        attestation: attestationFor(descriptor, { corpusResult: "failed" }),
        endpoint: null,
        reason: "attestation-corpus-incomplete",
      },
      {
        attestation: attestationFor(descriptor),
        endpoint: "a".repeat(64),
        reason: "attestation-boundary-incomplete",
      },
    ];
    for (const item of cases) {
      const registration = issueProductionBackendRegistration({
        backend,
        descriptor,
        attestation: item.attestation,
        purpose: "production",
      });
      expect(
        verifyProductionBackendRegistration({
          registration,
          backend,
          descriptor,
          now: systemClock.now(),
          expectedEndpointPolicyFingerprint: item.endpoint,
        }).reason,
      ).toBe(item.reason);
    }
  });

  it("pins production registration to the exact canonical platform corpus", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const expectedCount = secureBackendEscapeVectorCount(
      process.platform as "win32" | "linux" | "darwin",
    );
    const cases = [
      attestationFor(descriptor, {
        corpusVersion: SECURE_BACKEND_ESCAPE_CORPUS_VERSION + 1,
      }),
      attestationFor(descriptor, { corpusFingerprint: "9".repeat(64) }),
      attestationFor(descriptor, { corpusTestCount: expectedCount - 1 }),
    ];
    for (const attestation of cases) {
      const registration = issueProductionBackendRegistration({
        backend,
        descriptor,
        attestation,
        purpose: "production",
      });
      expect(
        verifyProductionBackendRegistration({
          registration,
          backend,
          descriptor,
          now: systemClock.now(),
          expectedEndpointPolicyFingerprint: null,
        }),
      ).toMatchObject({ verified: false, reason: "attestation-corpus-mismatch" });
    }

    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "production",
    });
    expect(
      verifyProductionBackendRegistration({
        registration,
        backend,
        descriptor,
        now: systemClock.now(),
        expectedEndpointPolicyFingerprint: null,
      }),
    ).toMatchObject({ verified: true, reason: null });
  });

  it("binds, consumes once, and rejects forged, mismatched, and stale receipts", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "production",
    });
    const now = systemClock.now().valueOf();
    const receipt = issueProductionSessionReceipt({
      registration,
      executionBindingFingerprint: "a".repeat(64),
      sandboxSessionFingerprint: "9".repeat(64),
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      nonce: "b".repeat(32),
    });
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt,
        registration,
        executionBindingFingerprint: "a".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        now: systemClock.now(),
      }).verified,
    ).toBe(true);
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt,
        registration,
        executionBindingFingerprint: "a".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-replayed");
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt: { ...receipt },
        registration,
        executionBindingFingerprint: "a".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-forged");

    const mismatch = issueProductionSessionReceipt({
      registration,
      executionBindingFingerprint: "c".repeat(64),
      sandboxSessionFingerprint: "9".repeat(64),
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      nonce: "d".repeat(32),
    });
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt: mismatch,
        registration,
        executionBindingFingerprint: "e".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-binding-mismatch");

    const stale = issueProductionSessionReceipt({
      registration,
      executionBindingFingerprint: "f".repeat(64),
      sandboxSessionFingerprint: "9".repeat(64),
      issuedAt: new Date(now - 2_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
      nonce: "1".repeat(32),
    });
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt: stale,
        registration,
        executionBindingFingerprint: "f".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-stale");

    const wrongSandbox = issueProductionSessionReceipt({
      registration,
      executionBindingFingerprint: "2".repeat(64),
      sandboxSessionFingerprint: "3".repeat(64),
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      nonce: "4".repeat(32),
    });
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt: wrongSandbox,
        registration,
        executionBindingFingerprint: "2".repeat(64),
        sandboxSessionFingerprint: "5".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-sandbox-mismatch");

    const invalidated = issueProductionSessionReceipt({
      registration,
      executionBindingFingerprint: "6".repeat(64),
      sandboxSessionFingerprint: "7".repeat(64),
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      nonce: "8".repeat(32),
    });
    invalidateProductionBackendRegistration(registration);
    expect(
      verifyAndConsumeProductionSessionReceipt({
        receipt: invalidated,
        registration,
        executionBindingFingerprint: "6".repeat(64),
        sandboxSessionFingerprint: "7".repeat(64),
        now: systemClock.now(),
      }).reason,
    ).toBe("session-receipt-registration-invalid");
  });

  it("rejects malformed or overlong receipt lifetimes at the internal issuer", () => {
    const descriptor = secureDescriptor();
    const backend = backendFor(descriptor);
    const registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "production",
    });
    const now = systemClock.now().valueOf();
    expect(() =>
      issueProductionSessionReceipt({
        registration,
        executionBindingFingerprint: "a".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        issuedAt: "not-a-time",
        expiresAt: new Date(now + 1_000).toISOString(),
        nonce: "b".repeat(32),
      }),
    ).toThrow(/bounded lifetime/);
    expect(() =>
      issueProductionSessionReceipt({
        registration,
        executionBindingFingerprint: "a".repeat(64),
        sandboxSessionFingerprint: "9".repeat(64),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
        nonce: "b".repeat(32),
      }),
    ).toThrow(/bounded lifetime/);
  });

  it("requires a receipt only in production final admission", () => {
    const development = evaluateFinalAdmission({
      mode: "development",
      registration: null,
      receipt: null,
      executionBindingFingerprint: "a".repeat(64),
      sandboxSessionFingerprint: "9".repeat(64),
      leaseValid: true,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      endpointPolicyExpiresAt: null,
      executableUnchanged: true,
      clock: systemClock,
    });
    expect(development.admitted).toBe(true);
    const production = evaluateFinalAdmission({
      ...development,
      mode: "production",
      registration: null,
      receipt: null,
      executionBindingFingerprint: "a".repeat(64),
      sandboxSessionFingerprint: "9".repeat(64),
      leaseValid: true,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      endpointPolicyExpiresAt: null,
      executableUnchanged: true,
      clock: systemClock,
    });
    expect(production).toMatchObject({
      admitted: false,
      reasons: ["session-receipt-invalid"],
    });
  });
});

describe("Stage 17 broker flow (mocked protocol, non-enforcement)", () => {
  async function mockProductionHarness(
    receiptMode: "valid" | "forged" | "missing",
    options: {
      readonly grantAccepted?: boolean;
      readonly disposalFails?: boolean;
      readonly terminationUnconfirmed?: boolean;
      readonly approvalEvidenceRefs?: readonly string[];
      readonly policyApprovalEvidenceRefs?: readonly string[];
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "adox-stage17-mock-"));
    roots.push(root);
    const inner = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") });
    const descriptor = secureDescriptor();
    let registration!: ProductionBackendRegistration;
    let prepareCount = 0;
    let spawnCount = 0;
    let validateCount = 0;
    const backend: SandboxBackend = {
      ...inner,
      describe: () => descriptor,
      probe: async () => ({ available: true, reason: "available", detail: null }),
      validateGrant: () => {
        validateCount += 1;
        return options.grantAccepted === false
          ? { available: false, reason: "not-implemented", detail: "grant-unsupported" }
          : { available: true, reason: "available", detail: null };
      },
      prepare: async (binding) => {
        prepareCount += 1;
        const session = await inner.prepare(binding);
        const preparedSession = Object.freeze({
          ...session,
          backendId: descriptor.backendId,
        });
        const preparedFingerprint = sandboxSessionFingerprint(preparedSession);
        const productionReceipt =
          receiptMode === "missing"
            ? null
            : receiptMode === "forged"
              ? {
                  schemaVersion: 1 as const,
                  registrationFingerprint: registration.registrationFingerprint,
                  executionBindingFingerprint: binding.executionBindingFingerprint,
                  sandboxSessionFingerprint: preparedFingerprint,
                  issuedAt: new Date(Date.now() - 1_000).toISOString(),
                  expiresAt: binding.expiresAt,
                  nonce: binding.nonce,
                }
              : issueProductionSessionReceipt({
                  registration,
                  executionBindingFingerprint: binding.executionBindingFingerprint,
                  sandboxSessionFingerprint: preparedFingerprint,
                  issuedAt: new Date(Date.now() - 1_000).toISOString(),
                  expiresAt: new Date(
                    Math.min(
                      Date.parse(binding.expiresAt),
                      Date.parse(registration.attestation.expiresAt),
                    ),
                  ).toISOString(),
                  nonce: binding.nonce,
                });
        return Object.freeze({
          ...preparedSession,
          productionReceipt,
        });
      },
      spawn: async (input) => {
        spawnCount += 1;
        const child = await inner.spawn(input);
        if (options.terminationUnconfirmed !== true) return child;
        return {
          pid: child.pid,
          onOutput: (listener) => child.onOutput(listener),
          wait: () => child.wait(),
          terminateTree: async (graceMs) => {
            await child.terminateTree(graceMs);
            return { outcome: "termination-unconfirmed" as const, stoppedCount: null };
          },
          writeStdin: (bytes) => child.writeStdin(bytes),
          closeStdin: () => child.closeStdin(),
        };
      },
      dispose: async (session) => {
        if (options.disposalFails === true) throw new Error("raw disposal detail");
        await inner.dispose(session);
      },
      close: () => inner.close(),
    };
    registration = issueProductionBackendRegistration({
      backend,
      descriptor,
      attestation: attestationFor(descriptor),
      purpose: "production",
    });
    const broker = createProcessBroker({
      backend,
      mode: "production",
      approvedBackendIds: [descriptor.backendId],
      productionRegistration: registration,
      policy:
        options.policyApprovalEvidenceRefs === undefined
          ? allowAllPolicy
          : {
              evaluateCommand: ({ request }) => ({
                outcome: "allowed" as const,
                fingerprint: request.policyDecisionFingerprint,
                approvalsToConsume: options.policyApprovalEvidenceRefs ?? [],
              }),
            },
      clock: systemClock,
    });
    const baseTool = fixtureTool();
    const tool = createTrustedToolDescriptor({
      ...baseTool,
      immutableReference: "test-image-v1",
      argumentPolicy: baseTool.argumentPolicy,
    });
    const grant = contractGrant(
      {
        approvalEvidenceRefs: options.approvalEvidenceRefs ?? [],
        tools: [
          {
            toolId: tool.toolId,
            digest: null,
            immutableReference: tool.immutableReference,
          },
        ],
      },
      systemClock,
    );
    const lease = createExecutionLease({
      leaseId: "lease-mock-production",
      grant,
      clock: systemClock,
    });
    const request = contractRequest(tool, {
      workspaceLeaseId: lease.leaseId,
      args: ["mocked-protocol-positive-control"],
      approvalEvidenceRefs: options.approvalEvidenceRefs ?? [],
    });
    return {
      broker,
      input: {
        request,
        grant,
        lease,
        workspaceRoot: root,
        workingDirectory: root,
        workspacePaths: {
          tempDir: join(root, "tmp"),
          homeDir: join(root, "home"),
          configDir: null,
          cacheDir: null,
        },
      },
      counts: () => ({ prepareCount, spawnCount, validateCount }),
    };
  }

  it("invokes validateGrant and exercises the opaque two-phase happy path", async () => {
    const harness = await mockProductionHarness("valid");
    const result = await harness.broker.execute(harness.input);
    expect(result.succeeded).toBe(true);
    expect(harness.counts()).toEqual({ prepareCount: 1, spawnCount: 1, validateCount: 1 });
    await harness.broker.close();
  });

  it.each(["missing", "forged"] as const)(
    "refuses a %s final receipt after preparation and before spawn",
    async (receiptMode) => {
      const harness = await mockProductionHarness(receiptMode);
      await expect(harness.broker.execute(harness.input)).rejects.toMatchObject({
        code: "PRODUCTION_ISOLATION_REQUIRED",
      });
      expect(harness.counts()).toEqual({ prepareCount: 1, spawnCount: 0, validateCount: 1 });
      await harness.broker.close();
    },
  );

  it("binds a negative validateGrant result and refuses before prepare", async () => {
    const harness = await mockProductionHarness("valid", { grantAccepted: false });
    await expect(harness.broker.execute(harness.input)).rejects.toMatchObject({
      code: "PRODUCTION_ISOLATION_REQUIRED",
    });
    expect(harness.counts()).toEqual({ prepareCount: 0, spawnCount: 0, validateCount: 1 });
    await harness.broker.close();
  });

  it("requires the policy to consume the exact supplied approval evidence", async () => {
    const harness = await mockProductionHarness("valid", {
      approvalEvidenceRefs: ["approval-a"],
      policyApprovalEvidenceRefs: [],
    });
    await expect(harness.broker.execute(harness.input)).rejects.toMatchObject({
      code: "INVALID_GRANT",
    });
    expect(harness.counts()).toEqual({ prepareCount: 0, spawnCount: 0, validateCount: 1 });
    await harness.broker.close();
  });

  it("rejects duplicated policy approval evidence even when the count matches", async () => {
    const harness = await mockProductionHarness("valid", {
      approvalEvidenceRefs: ["approval-a", "approval-b"],
      policyApprovalEvidenceRefs: ["approval-a", "approval-a"],
    });
    await expect(harness.broker.execute(harness.input)).rejects.toMatchObject({
      code: "INVALID_GRANT",
    });
    expect(harness.counts()).toEqual({ prepareCount: 0, spawnCount: 0, validateCount: 1 });
    await harness.broker.close();
  });

  it("derives and contains the real working directory instead of trusting a flag", async () => {
    const harness = await mockProductionHarness("valid");
    const outside = await mkdtemp(join(tmpdir(), "adox-stage17-outside-"));
    roots.push(outside);
    await expect(
      harness.broker.execute({
        ...harness.input,
        workingDirectory: outside,
        workspacePathTrusted: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    expect(harness.counts()).toEqual({ prepareCount: 0, spawnCount: 0, validateCount: 1 });
    await harness.broker.close();
  });

  it("rejects an explicit working-subdirectory claim that differs from reality", async () => {
    const harness = await mockProductionHarness("valid");
    await expect(
      harness.broker.execute({
        ...harness.input,
        request: {
          ...harness.input.request,
          workingSubdirectory: "claimed-subdirectory",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    expect(harness.counts()).toEqual({ prepareCount: 0, spawnCount: 0, validateCount: 1 });
    await harness.broker.close();
  });

  it("never reports success when production disposal is unconfirmed", async () => {
    const harness = await mockProductionHarness("valid", { disposalFails: true });
    await expect(harness.broker.execute(harness.input)).rejects.toMatchObject({
      code: "SANDBOX_DISPOSAL_FAILED",
    });
    expect(harness.counts()).toEqual({ prepareCount: 1, spawnCount: 1, validateCount: 1 });
    await harness.broker.close();
  });

  it("turns termination-unconfirmed into backend-lost rather than quota success", async () => {
    const harness = await mockProductionHarness("valid", { terminationUnconfirmed: true });
    const request = contractRequest(harness.input.request.tool, {
      workspaceLeaseId: harness.input.lease.leaseId,
      args: ["--sleep-forever"],
      quotas: createProcessQuotas({ wallClockMs: 500, outputBytes: 65_536 }),
    });
    const result = await harness.broker.execute({ ...harness.input, request });
    expect(result).toMatchObject({
      succeeded: false,
      state: "backend-lost",
      failure: { code: "PROCESS_TREE_TERMINATION_FAILED" },
    });
    await harness.broker.close();
  });

  it("refuses a self-declared secure backend before prepare without opaque registration", async () => {
    const harness = await mockProductionHarness("valid");
    await harness.broker.close();
    const root = await mkdtemp(join(tmpdir(), "adox-stage17-forgery-"));
    roots.push(root);
    const descriptor = secureDescriptor();
    let prepared = 0;
    const fake: SandboxBackend = {
      ...backendFor(descriptor),
      prepare: async () => {
        prepared += 1;
        throw new Error("must not prepare");
      },
    };
    const broker = createProcessBroker({
      backend: fake,
      mode: "production",
      approvedBackendIds: [descriptor.backendId],
      policy: allowAllPolicy,
      clock: systemClock,
    });
    const baseTool = fixtureTool();
    const tool = createTrustedToolDescriptor({
      ...baseTool,
      immutableReference: "test-image-v1",
      argumentPolicy: baseTool.argumentPolicy,
    });
    const grant = contractGrant(
      {
        tools: [{ toolId: tool.toolId, digest: null, immutableReference: tool.immutableReference }],
      },
      systemClock,
    );
    const lease = createExecutionLease({ leaseId: "lease-forgery", grant, clock: systemClock });
    const request = contractRequest(tool, { workspaceLeaseId: lease.leaseId });
    await expect(
      broker.execute({
        request,
        grant,
        lease,
        workspaceRoot: root,
        workingDirectory: root,
        workspacePaths: {
          tempDir: join(root, "tmp"),
          homeDir: null,
          configDir: null,
          cacheDir: null,
        },
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_ISOLATION_REQUIRED" });
    expect(prepared).toBe(0);
    await broker.close();
  });
});
