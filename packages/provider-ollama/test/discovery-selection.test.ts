import { describe, expect, it } from "vitest";
import {
  createOllamaAdapterConfiguration,
  discoverOllamaCatalog,
  createFetchOllamaTransport,
  normalizeOllamaCapabilities,
  parseOllamaEndpoint,
  selectOllamaModel,
  toStage2ModelCapabilities,
  type OllamaAdapterConfigurationInput,
  type OllamaModelCatalog,
} from "../src/index.js";
import {
  fakeDigest,
  startFakeOllamaServer,
  type FakeModelSpec,
  type FakeOllamaServerOptions,
} from "./helpers/fake-ollama-server.js";

const FIXED_NOW = new Date("2026-08-02T12:00:00.000Z");

async function discover(
  serverOptions: FakeOllamaServerOptions,
  configurationOverrides: Partial<OllamaAdapterConfigurationInput> = {},
): Promise<OllamaModelCatalog> {
  const server = await startFakeOllamaServer(serverOptions);
  try {
    const configuration = createOllamaAdapterConfiguration({
      instanceId: "ollama-test-1",
      endpoint: server.url,
      ...configurationOverrides,
    });
    const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
    try {
      return await discoverOllamaCatalog({ transport, configuration, now: () => FIXED_NOW });
    } finally {
      transport.close();
    }
  } finally {
    await server.close();
  }
}

const MODELS: readonly FakeModelSpec[] = [
  {
    name: "deepseek-r1:8b",
    digest: fakeDigest(1),
    size: 5_000,
    capabilities: ["completion", "thinking"],
    contextLength: 131_072,
    family: "deepseek2",
    families: ["deepseek2"],
    parameterSize: "8.0B",
    quantizationLevel: "Q4_K_M",
  },
  {
    name: "gemma3:12b",
    digest: fakeDigest(2),
    size: 8_000,
    capabilities: ["completion", "vision"],
    contextLength: 131_072,
    family: "gemma3",
    families: ["gemma3"],
    parameterSize: "12.2B",
    quantizationLevel: "Q4_K_M",
  },
  {
    name: "mistral:7b",
    digest: fakeDigest(3),
    size: 4_000,
    capabilities: ["completion", "tools"],
    contextLength: 32_768,
    family: "mistral",
    families: ["mistral"],
    parameterSize: "7.2B",
    quantizationLevel: "Q4_0",
  },
  {
    name: "qwen3:8b",
    digest: fakeDigest(4),
    size: 5_200,
    capabilities: ["completion", "tools", "thinking"],
    contextLength: 40_960,
    family: "qwen3",
    families: ["qwen3"],
    parameterSize: "8.2B",
    quantizationLevel: "Q4_K_M",
  },
  {
    name: "llama3.2:3b",
    digest: fakeDigest(5),
    size: 2_000,
    capabilities: ["completion", "tools"],
    contextLength: 131_072,
    family: "llama",
    families: ["llama"],
    parameterSize: "3.2B",
    quantizationLevel: "Q4_K_M",
  },
  {
    name: "nomic-embed-text",
    digest: fakeDigest(6),
    size: 300,
    capabilities: ["embedding"],
    contextLength: 2_048,
    family: "nomic-bert",
    families: ["nomic-bert"],
    parameterSize: "137M",
    quantizationLevel: "F16",
  },
];

describe("catalog discovery", () => {
  it("handles an empty installed catalog", async () => {
    const catalog = await discover({ models: [] });
    expect(catalog.entries).toHaveLength(0);
    expect(catalog.fingerprint).toHaveLength(64);
  });

  it("catalogs multiple families deterministically, independent of response order", async () => {
    const forward = await discover({ models: MODELS });
    const reversed = await discover({ models: [...MODELS].reverse() });
    expect(forward.entries.map((entry) => entry.name)).toEqual(
      [...MODELS.map((model) => model.name)].sort(),
    );
    expect(forward.fingerprint).toBe(reversed.fingerprint);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.entries[0])).toBe(true);
  });

  it("validates digests and reports capability provenance", async () => {
    const catalog = await discover({ models: MODELS });
    const deepseek = catalog.entries.find((entry) => entry.name === "deepseek-r1:8b")!;
    expect(deepseek.digest).toBe(fakeDigest(1));
    expect(deepseek.capabilities.reasoning).toBe(true);
    expect(deepseek.capabilities.toolCalling).toBe(false);
    expect(deepseek.capabilities.provenance["reasoning"]).toBe("reported");
    expect(deepseek.capabilities.provenance["structuredOutput"]).toBe("derived");
    expect(deepseek.contextLength).toBe(131_072);
    const embed = catalog.entries.find((entry) => entry.name === "nomic-embed-text")!;
    expect(embed.eligible).toBe(false);
    expect(embed.ineligibilityReasons).toContain("no-chat-capability");
  });

  it("marks invalid digests ineligible", async () => {
    const catalog = await discover({
      models: [{ ...MODELS[0]!, digest: "not-a-digest" }],
    });
    expect(catalog.entries[0]!.digest).toBeNull();
    expect(catalog.entries[0]!.eligible).toBe(false);
    expect(catalog.entries[0]!.ineligibilityReasons).toContain("invalid-digest");
  });

  it("tracks digest pins: matched, mismatched, and unverifiable", async () => {
    const matched = await discover(
      { models: [MODELS[0]!] },
      { digestPins: [{ model: "deepseek-r1:8b", digest: fakeDigest(1) }] },
    );
    expect(matched.entries[0]!.pin).toBe("matched");
    expect(matched.entries[0]!.eligible).toBe(true);

    const mismatched = await discover(
      { models: [MODELS[0]!] },
      { digestPins: [{ model: "deepseek-r1:8b", digest: fakeDigest(9) }] },
    );
    expect(mismatched.entries[0]!.pin).toBe("mismatched");
    expect(mismatched.entries[0]!.eligible).toBe(false);
    expect(mismatched.entries[0]!.ineligibilityReasons).toContain("digest-mismatch");

    const unverifiable = await discover(
      { models: [{ ...MODELS[0]!, digest: "garbage" }] },
      { digestPins: [{ model: "deepseek-r1:8b", digest: fakeDigest(1) }] },
    );
    expect(unverifiable.entries[0]!.pin).toBe("unverifiable");
    expect(unverifiable.entries[0]!.eligible).toBe(false);
  });

  it("applies allowlists, denylists, and restrictive capability overrides", async () => {
    const catalog = await discover(
      { models: MODELS },
      {
        modelAllowlist: ["qwen3:8b", "mistral:7b"],
        modelDenylist: ["mistral:7b"],
        capabilityOverrides: [
          { model: "qwen3:8b", denyToolCalling: true, maxContextLength: 8_192 },
        ],
      },
    );
    const qwen = catalog.entries.find((entry) => entry.name === "qwen3:8b")!;
    expect(qwen.eligible).toBe(true);
    expect(qwen.capabilities.toolCalling).toBe(false);
    expect(qwen.capabilities.provenance["toolCalling"]).toBe("configuration-restricted");
    expect(qwen.contextLength).toBe(8_192);
    expect(catalog.entries.find((entry) => entry.name === "mistral:7b")!.ineligibilityReasons).toContain(
      "model-denied",
    );
    expect(catalog.entries.find((entry) => entry.name === "llama3.2:3b")!.ineligibilityReasons).toContain(
      "not-allowlisted",
    );
  });

  it("replays byte-identical fingerprints for identical catalogs", async () => {
    const first = await discover({ models: MODELS });
    const second = await discover({ models: MODELS });
    expect(first.fingerprint).toBe(second.fingerprint);
    const changed = await discover({ models: [{ ...MODELS[0]!, digest: fakeDigest(7) }, ...MODELS.slice(1)] });
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("marks running models and tolerates ps failures", async () => {
    const running = await discover({
      models: MODELS,
      running: [{ name: "qwen3:8b", size: 5_200 }],
    });
    expect(running.entries.find((entry) => entry.name === "qwen3:8b")!.running).toBe(true);
    const noPs = await discover({
      models: [MODELS[0]!],
      overrides: { ps: { status: 500, body: '{"error":"boom"}' } },
    });
    expect(noPs.entries[0]!.running).toBe(false);
    // The fingerprint excludes the volatile running flag.
    expect(running.fingerprint).toBe((await discover({ models: MODELS })).fingerprint);
  });

  it("marks models ineligible when show details are unavailable", async () => {
    const catalog = await discover({
      models: [MODELS[0]!],
      overrides: { show: { status: 500, body: '{"error":"boom"}' } },
    });
    expect(catalog.entries[0]!.eligible).toBe(false);
    expect(catalog.entries[0]!.ineligibilityReasons).toContain("details-unavailable");
  });
});

describe("capability normalization", () => {
  it("keeps unknown capabilities unavailable rather than optimistic", () => {
    const unknown = normalizeOllamaCapabilities({
      reportedCapabilities: [],
      contextLength: null,
      override: null,
    });
    expect(unknown.chat).toBe(false);
    expect(unknown.toolCalling).toBe(false);
    expect(unknown.provenance["chat"]).toBe("unknown");
  });

  it("cannot manufacture a capability through configuration", () => {
    const restricted = normalizeOllamaCapabilities({
      reportedCapabilities: ["completion"],
      contextLength: 4_096,
      override: {
        model: "m",
        denyToolCalling: false,
        denyStructuredOutput: false,
        denyReasoning: false,
        denyVision: false,
        maxContextLength: null,
      },
    });
    expect(restricted.toolCalling).toBe(false);
    expect(restricted.reasoning).toBe(false);
  });

  it("converts to Stage 2 capabilities with conservative defaults", () => {
    const capabilities = normalizeOllamaCapabilities({
      reportedCapabilities: ["completion", "tools"],
      contextLength: null,
      override: null,
    });
    const stage2 = toStage2ModelCapabilities({
      providerId: "ollama",
      modelName: "mistral:7b",
      capabilities,
      family: "mistral",
      families: ["mistral"],
      parameterSize: "7.2B",
    });
    expect(stage2).toMatchObject({
      locality: "local",
      supportsToolUse: true,
      supportsVision: false,
      contextWindowTokens: 4_096,
      latencyClass: "fast",
      cost: null,
    });
    // Registry names outside the domain ModelId grammar are unrepresentable.
    expect(
      toStage2ModelCapabilities({
        providerId: "ollama",
        modelName: "hf.co/team/model:latest",
        capabilities,
        family: null,
        families: [],
        parameterSize: null,
      }),
    ).toBeNull();
  });
});

describe("role-preference selection", () => {
  const CONFIG = {
    rolePreferences: [
      {
        role: "planning" as const,
        families: ["deepseek2", "qwen3"],
        models: [],
        requireReasoning: true,
      },
      {
        role: "testing" as const,
        families: ["qwen3"],
        models: ["qwen3:8b"],
        requireToolCalling: true,
      },
      {
        role: "documentation" as const,
        families: ["gemma3"],
        models: [],
      },
      {
        role: "explanation" as const,
        families: ["llama"],
        models: ["llama3.2:3b"],
      },
      {
        role: "implementation" as const,
        families: ["mistral"],
        models: [],
        requireToolCalling: true,
      },
    ],
  };

  async function catalogOf(models: readonly FakeModelSpec[] = MODELS): Promise<{
    catalog: OllamaModelCatalog;
    configuration: ReturnType<typeof createOllamaAdapterConfiguration>;
  }> {
    const server = await startFakeOllamaServer({ models });
    try {
      const configuration = createOllamaAdapterConfiguration({
        instanceId: "ollama-test-1",
        endpoint: server.url,
        ...CONFIG,
      });
      const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
      try {
        const catalog = await discoverOllamaCatalog({ transport, configuration, now: () => FIXED_NOW });
        return { catalog, configuration };
      } finally {
        transport.close();
      }
    } finally {
      await server.close();
    }
  }

  it("selects by exact model preference before family preference", async () => {
    const { catalog, configuration } = await catalogOf();
    const result = selectOllamaModel(catalog, configuration, { role: "testing" });
    expect(result).toMatchObject({
      status: "selected",
      model: "qwen3:8b",
      matchedBy: "model-preference",
      preferenceRank: 0,
      fallbackUsed: false,
    });
  });

  it("selects by ranked family preference with capability requirements", async () => {
    const { catalog, configuration } = await catalogOf();
    const result = selectOllamaModel(catalog, configuration, { role: "planning" });
    expect(result).toMatchObject({
      status: "selected",
      model: "deepseek-r1:8b",
      matchedBy: "family-preference",
      preferenceRank: 0,
    });
    if (result.status !== "selected") {
      throw new Error("unreachable");
    }
    expect(result.capabilityEvidence.reasoning).toBe(true);
    expect(result.catalogFingerprint).toBe(catalog.fingerprint);
    const rejectedNames = result.rejectedCandidates.map((candidate) => candidate.model);
    expect(rejectedNames).toContain("mistral:7b");
    expect(
      result.rejectedCandidates.find((candidate) => candidate.model === "mistral:7b")!.reasonCodes,
    ).toContain("missing-reasoning");
  });

  it("falls back to a capability-compatible family when the exact name is missing", async () => {
    // The preferred exact model llama3.2:3b is not installed, but another
    // llama-family model is.
    const withoutPreferred = MODELS.filter((model) => model.name !== "llama3.2:3b");
    const llamaSibling: FakeModelSpec = {
      ...MODELS[4]!,
      name: "llama3.1:8b",
      digest: fakeDigest(8),
    };
    const { catalog, configuration } = await catalogOf([...withoutPreferred, llamaSibling]);
    const result = selectOllamaModel(catalog, configuration, { role: "explanation" });
    expect(result).toMatchObject({
      status: "selected",
      model: "llama3.1:8b",
      matchedBy: "family-preference",
    });
  });

  it("uses deterministic eligible fallback when no preference matches", async () => {
    const { catalog, configuration } = await catalogOf();
    const result = selectOllamaModel(catalog, configuration, { role: "review" });
    expect(result).toMatchObject({ status: "selected", matchedBy: "fallback", fallbackUsed: true });
    if (result.status !== "selected") {
      throw new Error("unreachable");
    }
    expect(result.model).toBe("deepseek-r1:8b"); // first eligible by name order
  });

  it("returns a structured no-eligible-local-model result for the later router", async () => {
    const { catalog, configuration } = await catalogOf();
    const result = selectOllamaModel(catalog, configuration, {
      role: "planning",
      requirements: { minContextLength: 100_000_000 },
    });
    expect(result.status).toBe("no-eligible-local-model");
    expect(result.rejectedCandidates.length).toBeGreaterThan(0);
    for (const candidate of result.rejectedCandidates) {
      expect(candidate.reasonCodes.length).toBeGreaterThan(0);
    }
  });

  it("enforces context, structured-output, reasoning, tool, and vision requirements", async () => {
    const { catalog, configuration } = await catalogOf();
    const tooling = selectOllamaModel(catalog, configuration, {
      role: null,
      requirements: { requireToolCalling: true, minContextLength: 100_000 },
    });
    expect(tooling).toMatchObject({ status: "selected", model: "llama3.2:3b" });

    const vision = selectOllamaModel(catalog, configuration, {
      role: null,
      requirements: { requireVision: true },
    });
    expect(vision).toMatchObject({ status: "selected", model: "gemma3:12b" });

    const structured = selectOllamaModel(catalog, configuration, {
      role: null,
      requirements: { requireStructuredOutput: true, requireReasoning: true },
    });
    expect(structured).toMatchObject({ status: "selected", model: "deepseek-r1:8b" });
  });

  it("replays identical selections for identical catalogs and explains rejections", async () => {
    const first = await catalogOf();
    const second = await catalogOf();
    const resultA = selectOllamaModel(first.catalog, first.configuration, { role: "planning" });
    const resultB = selectOllamaModel(second.catalog, second.configuration, { role: "planning" });
    expect(JSON.stringify(resultA)).toBe(JSON.stringify(resultB));
    expect(Object.isFrozen(resultA)).toBe(true);
  });

  it("honors digest-pin, size, and quantization preference constraints", async () => {
    const server = await startFakeOllamaServer({ models: MODELS });
    try {
      const configuration = createOllamaAdapterConfiguration({
        instanceId: "ollama-test-1",
        endpoint: server.url,
        digestPins: [{ model: "qwen3:8b", digest: fakeDigest(4) }],
        rolePreferences: [
          {
            role: "testing",
            families: ["qwen3", "mistral", "llama"],
            models: [],
            requireDigestPin: true,
          },
          {
            role: "documentation",
            families: ["gemma3", "llama"],
            models: [],
            maxModelSizeBytes: 3_000,
          },
          {
            role: "explanation",
            families: ["mistral", "llama"],
            models: [],
            allowedQuantizations: ["Q4_K_M"],
          },
        ],
      });
      const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
      try {
        const catalog = await discoverOllamaCatalog({ transport, configuration, now: () => FIXED_NOW });
        expect(selectOllamaModel(catalog, configuration, { role: "testing" })).toMatchObject({
          status: "selected",
          model: "qwen3:8b",
        });
        expect(selectOllamaModel(catalog, configuration, { role: "documentation" })).toMatchObject({
          status: "selected",
          model: "llama3.2:3b", // gemma3:12b exceeds the size cap
        });
        expect(selectOllamaModel(catalog, configuration, { role: "explanation" })).toMatchObject({
          status: "selected",
          model: "llama3.2:3b", // mistral:7b quantization Q4_0 is not allowed
        });
      } finally {
        transport.close();
      }
    } finally {
      await server.close();
    }
  });
});
