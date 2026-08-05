import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTER_CONFIGURATION,
  ROUTER_CONFIG_EXTENSION_NAMESPACE,
  RouterError,
  circuitIdentityFingerprint,
  createCircuitBreakerState,
  createManualRouterClock,
  createRouterConfiguration,
  parseRouterConfiguration,
  parseRouterConfigurationExtension,
  transitionCircuitBreaker
} from "../src/index.js";

const IDENTITY = Object.freeze({
  providerInstanceId: "provider-instance",
  contractModelId: "contract-model",
  operationClass: "planning"
});

function event(eventId: string, occurredAt: string, kind: "success" | "retryable-failure" | "terminal-provider-failure" | "admit-probe", identityFingerprint = circuitIdentityFingerprint(IDENTITY)) {
  return Object.freeze({ eventId, occurredAt, kind, identityFingerprint });
}

describe("router configuration and clock", () => {
  it("is versioned, immutable, fingerprinted, and supports bounded overrides", () => {
    const configured = createRouterConfiguration({
      fallbacks: Object.freeze({ enabled: false, maximumCount: 0 }),
      confidence: Object.freeze({ minimum: 700 })
    });
    expect(configured.schemaVersion).toBe(1);
    expect(configured.algorithmVersion).toBe(1);
    expect(configured.fallbacks.enabled).toBe(false);
    expect(configured.confidence.minimum).toBe(700);
    expect(Object.isFrozen(configured)).toBe(true);
    expect(parseRouterConfiguration(configured)).toEqual(configured);
    expect(() => parseRouterConfiguration({ ...configured, fingerprint: "0".repeat(64) }))
      .toThrow(/fingerprint/u);
  });

  it("accepts routing semantics only from a locked system extension", () => {
    const extension = Object.freeze({
      namespace: ROUTER_CONFIG_EXTENSION_NAMESPACE,
      schemaVersion: 1,
      value: DEFAULT_ROUTER_CONFIGURATION
    });
    expect(parseRouterConfigurationExtension(extension, {
      layer: "system",
      providersLocked: true
    })).toEqual(DEFAULT_ROUTER_CONFIGURATION);
    expect(() => parseRouterConfigurationExtension(extension, {
      layer: "project",
      providersLocked: true
    })).toThrow(/system layer/u);
    expect(() => parseRouterConfigurationExtension(
      { ...extension, namespace: "other" },
      { layer: "system", providersLocked: true }
    )).toThrow(/unsupported/u);
  });

  it("uses an injected mutable test clock and validates changes", () => {
    const clock = createManualRouterClock("2026-08-05T10:00:00.000Z");
    clock.advance(500);
    expect(clock.now().toISOString()).toBe("2026-08-05T10:00:00.500Z");
    clock.set("2026-08-05T11:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-08-05T11:00:00.000Z");
    expect(() => clock.advance(-1)).toThrow();
  });

  it("serializes finite router errors without hidden fields", () => {
    const error = new RouterError("INVALID_REQUEST", "bad request", { count: 2 });
    expect(error.toJSON()).toEqual({
      name: "RouterError",
      code: "INVALID_REQUEST",
      message: "bad request",
      details: { count: 2 }
    });
  });
});

describe("pure circuit breaker", () => {
  it("opens at threshold, deduplicates, rejects old events, admits one probe, and closes", () => {
    const configuration = createRouterConfiguration({
      circuitBreaker: Object.freeze({
        failureThreshold: 3,
        coolDownMs: 1_000,
        maximumRememberedEvents: 3
      })
    });
    let state = createCircuitBreakerState(IDENTITY);
    const one = transitionCircuitBreaker({
      state,
      event: event("failure-1", "2026-08-05T10:00:00.000Z", "retryable-failure"),
      configuration
    });
    expect(one.code).toBe("FAILURE_RECORDED");
    state = one.state;
    state = transitionCircuitBreaker({
      state,
      event: event("failure-2", "2026-08-05T10:00:00.100Z", "terminal-provider-failure"),
      configuration
    }).state;
    const opened = transitionCircuitBreaker({
      state,
      event: event("failure-3", "2026-08-05T10:00:00.200Z", "retryable-failure"),
      configuration
    });
    expect(opened.code).toBe("CIRCUIT_OPENED");
    expect(opened.state.phase).toBe("open");
    expect(transitionCircuitBreaker({
      state: opened.state,
      event: event("failure-3", "2026-08-05T10:00:00.200Z", "retryable-failure"),
      configuration
    }).code).toBe("DUPLICATE_EVENT");
    expect(transitionCircuitBreaker({
      state: opened.state,
      event: event("old", "2026-08-05T09:59:00.000Z", "success"),
      configuration
    }).code).toBe("OUT_OF_ORDER_EVENT");
    expect(transitionCircuitBreaker({
      state: opened.state,
      event: event("early-probe", "2026-08-05T10:00:01.000Z", "admit-probe"),
      configuration
    }).code).toBe("EVENT_NOT_APPLICABLE");
    const probe = transitionCircuitBreaker({
      state: opened.state,
      event: event("probe", "2026-08-05T10:00:01.200Z", "admit-probe"),
      configuration
    });
    expect(probe.code).toBe("PROBE_ADMITTED");
    expect(probe.state.phase).toBe("half-open");
    const closed = transitionCircuitBreaker({
      state: probe.state,
      event: event("probe-success", "2026-08-05T10:00:01.300Z", "success"),
      configuration
    });
    expect(closed.code).toBe("CIRCUIT_CLOSED");
    expect(closed.state.phase).toBe("closed");
    expect(closed.state.rememberedEventIds).toHaveLength(3);
  });

  it("reopens a failed half-open probe and rejects identity substitution", () => {
    const configuration = createRouterConfiguration({
      circuitBreaker: Object.freeze({
        failureThreshold: 1,
        coolDownMs: 100,
        maximumRememberedEvents: 8
      })
    });
    const initial = createCircuitBreakerState(IDENTITY);
    const opened = transitionCircuitBreaker({
      state: initial,
      event: event("open", "2026-08-05T10:00:00.000Z", "retryable-failure"),
      configuration
    });
    expect(transitionCircuitBreaker({
      state: opened.state,
      event: event("wrong", "2026-08-05T10:00:00.200Z", "admit-probe", "f".repeat(64)),
      configuration
    }).code).toBe("IDENTITY_MISMATCH");
    expect(transitionCircuitBreaker({
      state: opened.state,
      event: event("while-open", "2026-08-05T10:00:00.200Z", "success"),
      configuration
    }).code).toBe("EVENT_NOT_APPLICABLE");
    const probe = transitionCircuitBreaker({
      state: opened.state,
      event: event("probe-2", "2026-08-05T10:00:00.200Z", "admit-probe"),
      configuration
    });
    const reopened = transitionCircuitBreaker({
      state: probe.state,
      event: event("probe-failed", "2026-08-05T10:00:00.300Z", "terminal-provider-failure"),
      configuration
    });
    expect(reopened.code).toBe("CIRCUIT_REOPENED");
    expect(reopened.state.phase).toBe("open");
  });
});
