import { describe, expect, it } from "vitest";
import { isProviderError } from "@ai-dev-os/providers";
import {
  OLLAMA_ENDPOINTS,
  createFetchOllamaTransport,
  createOllamaAdapterConfiguration,
  isLoopbackOllamaEndpoint,
  parseOllamaAdapterConfiguration,
  parseOllamaEndpoint,
  resolveOllamaConfiguration,
} from "../src/index.js";
import { startFakeOllamaServer } from "./helpers/fake-ollama-server.js";

describe("loopback-only endpoint validation", () => {
  it("accepts literal IPv4 loopback endpoints across 127/8", () => {
    expect(parseOllamaEndpoint("http://127.0.0.1:11434")).toMatchObject({
      baseUrl: "http://127.0.0.1:11434",
      family: "ipv4-loopback",
      port: 11_434,
    });
    expect(parseOllamaEndpoint("http://127.1.2.3:8080").family).toBe("ipv4-loopback");
    expect(parseOllamaEndpoint("http://127.255.255.255:1").port).toBe(1);
    expect(parseOllamaEndpoint("http://127.0.0.1").port).toBe(80);
    expect(parseOllamaEndpoint("http://127.0.0.1:11434/").baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("accepts the exact IPv6 loopback literal", () => {
    const endpoint = parseOllamaEndpoint("http://[::1]:11434");
    expect(endpoint.family).toBe("ipv6-loopback");
    expect(endpoint.baseUrl).toBe("http://[::1]:11434");
  });

  it("rejects every non-loopback, ambiguous, or decorated endpoint", () => {
    const rejected = [
      "http://localhost:11434", // name resolution is ambiguous
      "http://LOCALHOST:11434",
      "http://0.0.0.0:11434",
      "http://[::]:11434",
      "http://192.168.1.10:11434", // private LAN
      "http://10.0.0.5:11434",
      "http://8.8.8.8:11434", // public
      "http://[::ffff:127.0.0.1]:11434", // IPv4-mapped IPv6
      "http://0177.0.0.1:11434", // octal host trick
      "http://2130706433:11434", // integer host trick
      "http://0x7f.0.0.1:11434", // hex host trick
      "http://127.0.0.01:11434", // leading-zero octet
      "http://user:pass@127.0.0.1:11434", // URL user information
      "http://user@127.0.0.1:11434",
      "http://127.0.0.1:11434?debug=1", // query string
      "http://127.0.0.1:11434#fragment", // fragment
      "http://127.0.0.1:11434/api", // base path
      "https://127.0.0.1:11434", // non-http scheme
      "ftp://127.0.0.1:11434",
      "file:///etc/passwd",
      "http://ollama.example.com:11434", // DNS name
      "http://127.0.0.1:0", // invalid port
      "http://127.0.0.1:70000",
      "http://127.0.0.1:011434",
      "http:127.0.0.1:11434",
      "//127.0.0.1:11434",
      "127.0.0.1:11434",
      "",
      "http://[::2]:11434",
      "http://[fe80::1]:11434",
      `http://127.0.0.1:11434${"/".repeat(300)}`,
    ];
    for (const candidate of rejected) {
      expect(isLoopbackOllamaEndpoint(candidate), candidate).toBe(false);
      expect(() => parseOllamaEndpoint(candidate)).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(isLoopbackOllamaEndpoint(42)).toBe(false);
    expect(isLoopbackOllamaEndpoint(null)).toBe(false);
  });

  it("rejects unsafe endpoints in the adapter configuration", () => {
    for (const endpoint of ["http://localhost:11434", "http://10.1.1.1:11434", "http://127.0.0.1/api"]) {
      expect(() =>
        createOllamaAdapterConfiguration({ instanceId: "ollama-1", endpoint }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }
  });

  it("keeps every request URL derived from the finite endpoint table", () => {
    // The transport exposes no caller-controlled path input at all: the
    // endpoint table is the complete reachable surface.
    expect(Object.keys(OLLAMA_ENDPOINTS).sort()).toEqual([
      "chat",
      "generate",
      "ps",
      "show",
      "tags",
      "version",
    ]);
    for (const route of Object.values(OLLAMA_ENDPOINTS)) {
      expect(route.path.startsWith("/api/")).toBe(true);
    }
    // Model-management operations are unrepresentable.
    for (const forbidden of ["pull", "delete", "copy", "create", "push"]) {
      expect(Object.keys(OLLAMA_ENDPOINTS)).not.toContain(forbidden);
      expect(Object.values(OLLAMA_ENDPOINTS).map((route) => route.path)).not.toContain(
        `/api/${forbidden}`,
      );
    }
  });

  it("rejects redirects before following them", async () => {
    const server = await startFakeOllamaServer({
      overrides: {
        version: { status: 302, headers: { location: "http://192.168.0.9:11434/api/version" } },
      },
    });
    try {
      const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
      await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
        (error: unknown) =>
          isProviderError(error, "PROTOCOL_VIOLATION") &&
          (error as { causeCategory: string | null }).causeCategory === "redirect-rejected",
      );
      // Only the original request was made; the redirect target was never fetched.
      expect(server.requests).toHaveLength(1);
      transport.close();
    } finally {
      await server.close();
    }
  });

  it("maps connection refusal to a structured network failure", async () => {
    const server = await startFakeOllamaServer({});
    const url = server.url;
    await server.close();
    const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(url) });
    await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
      (error: unknown) => isProviderError(error, "NETWORK_FAILURE"),
    );
    transport.close();
  });

  it("rejects requests after transport close", async () => {
    const server = await startFakeOllamaServer({});
    try {
      const transport = createFetchOllamaTransport({ endpoint: parseOllamaEndpoint(server.url) });
      transport.close();
      transport.close();
      await expect(transport.requestJson("version", null, { timeoutMs: 5_000 })).rejects.toSatisfy(
        (error: unknown) => isProviderError(error, "PROVIDER_CLOSED"),
      );
    } finally {
      await server.close();
    }
  });
});

describe("configuration validation", () => {
  const base = { instanceId: "ollama-1", endpoint: "http://127.0.0.1:11434" };

  it("applies documented defaults and freezes the result", () => {
    const configuration = createOllamaAdapterConfiguration(base);
    expect(configuration.requestTimeoutMs).toBe(300_000);
    expect(configuration.keepAlive).toEqual({ policy: "retain", durationMs: 300_000 });
    expect(configuration.maxConcurrentOperations).toBe(2);
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.endpoint)).toBe(true);
    expect(Object.isFrozen(configuration.rolePreferences)).toBe(true);
  });

  it("rejects invalid durations, limits, and unsafe integers", () => {
    expect(() => createOllamaAdapterConfiguration({ ...base, requestTimeoutMs: 0 })).toThrow();
    expect(() => createOllamaAdapterConfiguration({ ...base, requestTimeoutMs: 1.5 })).toThrow();
    expect(() => createOllamaAdapterConfiguration({ ...base, maxConcurrentOperations: 0 })).toThrow();
    expect(() => createOllamaAdapterConfiguration({ ...base, maxConcurrentOperations: 65 })).toThrow();
    expect(() => createOllamaAdapterConfiguration({ ...base, queueLimit: -1 })).toThrow();
    expect(() =>
      createOllamaAdapterConfiguration({ ...base, capacityBudgetBytes: Number.MAX_SAFE_INTEGER + 2 }),
    ).toThrow();
    expect(() =>
      createOllamaAdapterConfiguration({
        ...base,
        keepAlive: { policy: "retain", durationMs: 100 },
      }),
    ).toThrow();
    expect(() =>
      createOllamaAdapterConfiguration({
        ...base,
        capacityBudgetBytes: 1_000,
        capacitySafetyMarginBytes: 1_000,
      }),
    ).toThrow();
  });

  it("rejects duplicate model rules and malformed digest pins", () => {
    expect(() =>
      createOllamaAdapterConfiguration({
        ...base,
        perModelConcurrency: [
          { model: "m", limit: 1 },
          { model: "m", limit: 2 },
        ],
      }),
    ).toThrow();
    expect(() =>
      createOllamaAdapterConfiguration({
        ...base,
        digestPins: [{ model: "m", digest: "not-a-digest" }],
      }),
    ).toThrow();
    expect(() =>
      createOllamaAdapterConfiguration({
        ...base,
        digestPins: [
          { model: "m", digest: "a".repeat(64) },
          { model: "m", digest: "b".repeat(64) },
        ],
      }),
    ).toThrow();
    const pinned = createOllamaAdapterConfiguration({
      ...base,
      digestPins: [{ model: "m", digest: `sha256:${"A".repeat(64)}` }],
    });
    expect(pinned.digestPins[0]!.digest).toBe("a".repeat(64));
  });

  it("rejects prototype-pollution and unknown fields in the strict parser", () => {
    const full = JSON.parse(
      JSON.stringify(createOllamaAdapterConfiguration(base)).replace(
        /"endpoint":\{[^}]*\}/,
        '"endpoint":"http://127.0.0.1:11434"',
      ),
    ) as Record<string, unknown>;
    expect(() => parseOllamaAdapterConfiguration(full)).not.toThrow();
    expect(() =>
      parseOllamaAdapterConfiguration({ ...full, unknownField: true }),
    ).toThrow();
    expect(() =>
      parseOllamaAdapterConfiguration(
        JSON.parse(`${JSON.stringify(full).slice(0, -1)},"__proto__":{"polluted":true}}`),
      ),
    ).toThrow();
    expect(() => parseOllamaAdapterConfiguration(null)).toThrow();
    expect(() => parseOllamaAdapterConfiguration("configuration")).toThrow();
  });

  it("resolves the ollama extension namespace from provider configuration", () => {
    const configuration = resolveOllamaConfiguration({
      instanceId: "ollama-1",
      endpointBaseUrl: "http://127.0.0.1:11434",
      extensions: [
        { namespace: "other", schemaVersion: 3, value: { irrelevant: true } },
        {
          namespace: "ollama",
          schemaVersion: 1,
          value: { maxConcurrentOperations: 4, keepAlive: { policy: "unload-immediately" } },
        },
      ],
    });
    expect(configuration.maxConcurrentOperations).toBe(4);
    expect(configuration.keepAlive).toEqual({ policy: "unload-immediately" });
  });

  it("rejects extensions that override identity or endpoint, and hostile values", () => {
    expect(() =>
      resolveOllamaConfiguration({
        instanceId: "ollama-1",
        endpointBaseUrl: "http://127.0.0.1:11434",
        extensions: [
          { namespace: "ollama", schemaVersion: 1, value: { endpoint: "http://8.8.8.8:1" } },
        ],
      }),
    ).toThrow();
    expect(() =>
      resolveOllamaConfiguration({
        instanceId: "ollama-1",
        endpointBaseUrl: "http://127.0.0.1:11434",
        extensions: [{ namespace: "ollama", schemaVersion: 2, value: {} }],
      }),
    ).toThrow();
    expect(() =>
      resolveOllamaConfiguration({
        instanceId: "ollama-1",
        endpointBaseUrl: "http://127.0.0.1:11434",
        extensions: [{ namespace: "ollama", schemaVersion: 1, value: { rolePreferences: "hostile" } }],
      }),
    ).toThrow();
  });
});
