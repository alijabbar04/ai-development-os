import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKER_CONFIGURATION,
  ThinkerError,
  createProviderGatewayThinkerPort,
  parseThinkerConfiguration,
  parseThinkerRequest,
  resolveThinkerTarget
} from "../src/index.js";
import {
  createFakeThinkerPort,
  jsonClone,
  thinkerApplicationConfigurationFixture,
  thinkerRequestFixture
} from "../src/testing/fixtures.js";
import { promptTargetFixture } from "@ai-dev-os/prompt-compiler/testing/fixtures";
import {
  allowingPromptAuthorizer,
  promptCompilationRequestFixture
} from "@ai-dev-os/prompt-compiler/testing/fixtures";
import { compileThinkerPrompt } from "@ai-dev-os/prompt-compiler";
import type { ProviderGateway } from "@ai-dev-os/provider-gateway";

describe("thinker configuration and request", () => {
  it("parses the finite default configuration and rejects versions, unknown keys, and inconsistent bounds", () => {
    const parsed = parseThinkerConfiguration(DEFAULT_THINKER_CONFIGURATION);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseThinkerConfiguration({ ...parsed, schemaVersion: 2 })).toThrow();
    expect(() => parseThinkerConfiguration({ ...parsed, extra: true })).toThrow();
    expect(() =>
      parseThinkerConfiguration({ ...parsed, maxTextLength: 100, maxTitleLength: 101 })
    ).toThrow();
    expect(() =>
      parseThinkerConfiguration({ ...parsed, maxTextLength: 100, maxTitleLength: 100, maxObjectiveLength: 101 })
    ).toThrow();
  });

  it("binds the thinker request id to the exact parsed compilation request", () => {
    const fixture = thinkerRequestFixture();
    expect(parseThinkerRequest(fixture)).toEqual(fixture);
    expect(() => parseThinkerRequest({ ...fixture, requestId: "different-request" })).toThrow();
    expect(() => parseThinkerRequest({ ...fixture, selectedAlias: "Bad Alias" })).toThrow();
    expect(() => parseThinkerRequest({ ...fixture, unknown: true })).toThrow();
  });
});

describe("deterministic thinker target resolution", () => {
  it("uses the first planning alias by default and an explicit alternate override", () => {
    const port = createFakeThinkerPort();
    const configuration = thinkerApplicationConfigurationFixture();
    const primary = resolveThinkerTarget({
      configuration,
      port,
      expectedTarget: promptTargetFixture("primary")
    });
    expect(primary.selectedAlias).toBe("primary-thinker");
    const alternate = resolveThinkerTarget({
      configuration,
      selectedAlias: "alternate-thinker",
      port,
      expectedTarget: promptTargetFixture("alternate")
    });
    expect(alternate.selectedAlias).toBe("alternate-thinker");
    expect(alternate.instanceId).not.toBe(primary.instanceId);
  });

  it.each([
    [
      "missing planning preference",
      thinkerApplicationConfigurationFixture({ planningAliases: [] }),
      undefined,
      createFakeThinkerPort(),
      "TARGET_MISSING"
    ],
    [
      "unknown explicit alias",
      thinkerApplicationConfigurationFixture(),
      "unknown-thinker",
      createFakeThinkerPort(),
      "TARGET_MISSING"
    ],
    [
      "disabled configured provider",
      thinkerApplicationConfigurationFixture({ primaryEnabled: false }),
      undefined,
      createFakeThinkerPort(),
      "TARGET_DISABLED"
    ],
    [
      "coding-agent provider",
      thinkerApplicationConfigurationFixture({ primaryKind: "coding-agent" }),
      undefined,
      createFakeThinkerPort(),
      "TARGET_WRONG_KIND"
    ],
    [
      "gateway-disabled provider",
      thinkerApplicationConfigurationFixture(),
      undefined,
      createFakeThinkerPort({ primaryGatewayEnabled: false }),
      "TARGET_DISABLED"
    ],
    [
      "unavailable model",
      thinkerApplicationConfigurationFixture(),
      undefined,
      createFakeThinkerPort({ primaryAvailable: false }),
      "TARGET_INELIGIBLE"
    ]
  ])("rejects %s without routing", (_name, configuration, selectedAlias, port, code) => {
    expect(() =>
      resolveThinkerTarget({
        configuration,
        selectedAlias,
        port,
        expectedTarget: promptTargetFixture("primary")
      })
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects model, expected-target, snapshot, and capability substitution", () => {
    expect(() =>
      resolveThinkerTarget({
        configuration: thinkerApplicationConfigurationFixture({
          primaryAliasModelId: "other-contract-model"
        }),
        port: createFakeThinkerPort(),
        expectedTarget: promptTargetFixture("primary")
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH" }));
    expect(() =>
      resolveThinkerTarget({
        configuration: thinkerApplicationConfigurationFixture(),
        port: createFakeThinkerPort(),
        expectedTarget: promptTargetFixture("alternate")
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH" }));

    const base = createFakeThinkerPort();
    const primaryId = promptTargetFixture("primary").instanceId;
    const malformed = {
      ...base,
      getInstance: (instanceId: string) => {
        const snapshot = base.getInstance(instanceId);
        if (snapshot === undefined || instanceId !== primaryId) return snapshot;
        return { ...snapshot, fingerprint: "not-a-digest" };
      }
    };
    expect(() =>
      resolveThinkerTarget({
        configuration: thinkerApplicationConfigurationFixture(),
        port: malformed,
        expectedTarget: promptTargetFixture("primary")
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH" }));

    const ineligible = {
      ...base,
      getInstance: (instanceId: string) => {
        const snapshot = base.getInstance(instanceId);
        if (snapshot === undefined || instanceId !== primaryId) return snapshot;
        return {
          ...snapshot,
          descriptor: {
            ...snapshot.descriptor,
            capabilities: { ...snapshot.descriptor.capabilities, structuredOutput: false }
          }
        };
      }
    };
    expect(() =>
      resolveThinkerTarget({
        configuration: thinkerApplicationConfigurationFixture(),
        port: ineligible,
        expectedTarget: promptTargetFixture("primary")
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_INELIGIBLE" }));
  });

  it("forwards only the narrow gateway operations", async () => {
    const fake = createFakeThinkerPort();
    const gateway = {
      fingerprint: fake.fingerprint,
      getInstance: fake.getInstance,
      preflight: fake.preflight,
      invoke: fake.invoke
    } as ProviderGateway;
    const port = createProviderGatewayThinkerPort(gateway);
    expect(port.fingerprint()).toBe(fake.fingerprint());
    const instanceId = promptTargetFixture("primary").instanceId;
    expect(port.getInstance(instanceId)).toBeDefined();
    expect(fake.snapshot(instanceId)).toBeDefined();
    const compiled = await compileThinkerPrompt(promptCompilationRequestFixture(), {
      authorizer: allowingPromptAuthorizer()
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(port.preflight({ instanceId, request: compiled.value.inferenceRequest }).instance.instanceId).toBe(
      instanceId
    );
    const operation = await port.invoke({ instanceId, request: compiled.value.inferenceRequest });
    const events = [];
    for await (const event of operation.events()) events.push(event.kind);
    await operation.result;
    expect(events.at(-1)).toBe("operation-completed");
  });

  it("uses safe path-free thinker errors", () => {
    const error = new ThinkerError("TARGET_MISSING", "Target is absent.", { count: 0 });
    expect(error.stack).toBe("ThinkerError: Target is absent.");
    expect(error.toJSON()).toEqual({
      name: "ThinkerError",
      code: "TARGET_MISSING",
      message: "Target is absent.",
      details: { count: 0 }
    });
    expect(JSON.stringify(error)).not.toContain("configuration-target.test");
  });
});
