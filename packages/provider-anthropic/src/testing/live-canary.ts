/**
 * Backward-compatible testing entry point. The implementation now lives in
 * the explicitly production-disabled validation subpath so the fixed effect
 * is not duplicated between test and application compositions.
 */
export * from "../validation/live-canary.js";
