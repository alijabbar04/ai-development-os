import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ERROR_CODES, credentialErrorCopy } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "browser");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "entry.css"), "utf8");
const source = readFileSync(join(root, "entry.ts"), "utf8");

describe("browser component contract", () => {
  it("keeps the actual renderer refusal catalogue exactly equal to the exported finite catalogue", () => {
    const start = source.indexOf("const ERROR_COPY:");
    const end = source.indexOf("\n});", start);
    const block = source.slice(start, end + 4);
    const extracted = new Map([...block.matchAll(/^\s{2}([A-Z_]+): \{ title: ("(?:[^"\\]|\\.)*"), body: ("(?:[^"\\]|\\.)*") \},$/gmu)]
      .map((match) => [match[1]!, { title: JSON.parse(match[2]!) as string, body: JSON.parse(match[3]!) as string }] as const));
    expect([...extracted.keys()].sort()).toEqual([...CREDENTIAL_ERROR_CODES].sort());
    for (const code of CREDENTIAL_ERROR_CODES) expect(extracted.get(code)).toEqual(credentialErrorCopy(code));
  });

  it("is Electron-free, Node-free, network-free, storage-free, and has no HTML injection sink", () => {
    expect(source).not.toMatch(/from\s+["']electron["']|require\s*\(\s*["']electron/);
    expect(source).not.toMatch(/node:|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\s*\(|new Function/);
    expect(source).not.toMatch(/navigator\.clipboard|clipboardData|execCommand/);
  });

  it("uses the exact strict CSP and exactly three same-origin packaged assets", () => {
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "worker-src 'none'"]) expect(html).toContain(directive);
    expect(html).toContain('href="./entry.css"');
    expect(html).toContain('src="./entry.js"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("contains password-field cleanup before awaiting, native button picker semantics, no reveal/copy/export, and actual clipboard-result copy", () => {
    const clear = source.indexOf('key.value = "";', source.indexOf("const secret = key.value"));
    const invoke = source.indexOf("await finite(api.save", source.indexOf("const secret = key.value"));
    expect(clear).toBeGreaterThan(0);
    expect(invoke).toBeGreaterThan(clear);
    expect(source).toContain('const picker = element("ul", { className: "provider-picker" })');
    expect(source).toContain('const item = element("li", { attrs: { "data-slot-id": slot.slotId } })');
    expect(source).toContain('const row = element("button", { attrs: { type: "button" } })');
    expect(source).not.toMatch(/element\("button",\s*\{[^\n]*role:\s*"listitem"/u);
    expect(source).not.toMatch(/Reveal credential|Show credential|Copy credential|Export credential/);
    expect(source).toContain('result.clipboard.outcome === "cleared"');
    expect(source).toContain('result.clipboard.outcome === "not-requested"');
  });

  it("contains no realistic key-shaped value in source, HTML, or CSS", () => {
    const combined = `${source}\n${html}\n${css}`;
    const realistic = /(sk-ant-api\d{2}-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-or-v1-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,})/;
    expect(combined).not.toMatch(realistic);
  });

  it("provides reduced-motion, forced-colours, focus, responsive, and non-clipping rules", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("forced-colors: active");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("white-space: normal");
    expect(css).toContain("[hidden] { display: none !important; }");
    expect(css).toContain("@media (max-width: 980px)");
    expect(css).toContain("@media (max-width: 820px)");
    expect(css).toContain('h3[data-busy-focus="true"]:focus');
    expect(css).toContain('h1[tabindex="-1"]:focus');
  });

  it("provides visible and programmatic reasons for disabled credential actions", () => {
    expect(source).toContain('className: "action-reasons"');
    expect(source).toContain('className: "action-reasons global-action-reason"');
    expect(source).toContain("unavailable —");
    expect(source).toContain("unavailable until this check finishes");
    expect(source).toContain('setAttribute("aria-describedby", reasonId)');
    expect(source).toContain('setAttribute("aria-describedby", GLOBAL_ACTION_REASON_ID)');
    expect(source).toContain('id: GLOBAL_ACTION_REASON_ID');
    expect(source).toContain("REOPEN_FOR_STORAGE_CHANGE");
    expect(source).toContain('sessionPresentationState = "committed"');
    expect(source).toContain("const refreshed = await refresh(false, true)");
    expect(source).toContain('sessionPresentationState = refreshed ? "editing" : "failed"');
  });

  it("gives every dialog an accessible name, restores opener focus, and uses one live announcement path", () => {
    expect(source).toContain('attrs: { "aria-labelledby": titleId }');
    expect(source).toContain("dialogOpeners.set(dialog, opener)");
    expect(source).toContain("opener.focus()");
    expect(source).toContain('"data-notice-kind": kind');
    expect(source).toContain('kind === "outcome" ? "Action result" : "Refresh warning"');
    expect(source).not.toMatch(/text: "(?:Encrypting|Validating)[^\n]*role: "status"/u);
  });

  it("keeps clipboard wording on save/replacement only and provides a protected-field Clear control", () => {
    expect(source).toContain('result.kind === "saved"');
    expect(source).toContain('result.kind === "rotated"');
    expect(source).toContain("This local change did not validate or contact the provider.");
    expect(source).toContain("Some presentation details or Activity history could not be updated.");
    expect(source).not.toContain("Nonsecret ownership or enable metadata could not be updated.");
    expect(source).toContain('const clearKey = button("Clear"');
    expect(source).toContain("Field cleared. Nothing pasted yet.");
    expect(source).toContain("clearKey.disabled = key.value.length === 0");
    expect(source).toContain("localCredentialFormat(slot.slotId, key.value)");
    expect(source).not.toContain("key.value.trim()");
  });

  it("renders a synchronously blocked post-commit model before awaiting authoritative refresh", () => {
    const committed = source.indexOf('sessionPresentationState = "committed"');
    const rendered = source.indexOf("render();", committed);
    const refreshed = source.indexOf("await refresh(false, true)", committed);
    expect(committed).toBeGreaterThan(0);
    expect(rendered).toBeGreaterThan(committed);
    expect(refreshed).toBeGreaterThan(rendered);
    expect(source).toContain("authoritativeStateFresh = false");
    expect(source).toContain("Current credential state is being refreshed");
  });

  it("refreshes authoritative state before releasing actions after a discarded validation", () => {
    const discarded = source.indexOf("if (result.discarded)");
    const blocked = source.indexOf("refreshInFlight = true", discarded);
    const refusal = source.indexOf('code: "VALIDATION_STALE"', discarded);
    const refreshed = source.indexOf("await refresh(false, true)", discarded);
    const released = source.indexOf("refreshInFlight = false", discarded);
    expect(discarded).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(discarded);
    expect(refusal).toBeGreaterThan(blocked);
    expect(refreshed).toBeGreaterThan(refusal);
    expect(released).toBeGreaterThan(refreshed);
  });

  it("renders effect-bearing validation recording uncertainty and refreshes every validation refusal", () => {
    const validated = source.indexOf('if (result.kind === "validated")');
    const recording = source.indexOf('result.activityRecording !== "recorded"', validated);
    const dispatched = source.indexOf("result.providerDispatched", recording);
    const finiteCopy = source.indexOf("Exactly one provider check completed. Nothing was retried.", validated);
    const refresh = source.indexOf("await refresh(false, true)", finiteCopy);
    expect(validated).toBeGreaterThan(0);
    expect(recording).toBeGreaterThan(validated);
    expect(dispatched).toBeGreaterThan(recording);
    expect(finiteCopy).toBeGreaterThan(dispatched);
    expect(refresh).toBeGreaterThan(finiteCopy);

    const denied = source.indexOf('if (expected === "validation")');
    const denialShown = source.indexOf("showRefusal(result, expected)", denied);
    const denialRefresh = source.indexOf("await refresh(false, true)", denialShown);
    expect(denied).toBeGreaterThan(0);
    expect(denialShown).toBeGreaterThan(denied);
    expect(denialRefresh).toBeGreaterThan(denialShown);
    expect(source).not.toContain('expected === "validation" && result.code === "VALIDATION_POLICY_DENIED"');
  });

  it("describes no-dispatch failures without inventing a deadline or provider response", () => {
    expect(source).toContain('ambiguous: { tone: "warn", title: "Check unclear", body: `The check did not clearly accept or reject');
    expect(source).not.toContain("The provider response did not clearly accept or reject");
    expect(source).toContain(": result.deadlineExpired ? `The deadline expired");
    expect(source).toContain(": `The check ended at ${observed} before provider dispatch. No provider request was sent; nothing was retried");
  });

  it("blocks the rendered surface and makes Escape inert during validation and removal", () => {
    const validation = source.indexOf("validationSubmitting = true");
    const validationRender = source.indexOf("render();", validation);
    const validationAwait = source.indexOf("await awaitValidationSettlement(api.validate", validation);
    const removal = source.indexOf("removalSubmitting = true");
    const removalRender = source.indexOf("render();", removal);
    const removalAwait = source.indexOf("await finite(api.remove", removal);
    expect(source).toContain("if (!validationSubmitting) destroyDialog(shell.dialog)");
    expect(source).toContain("if (!removalSubmitting) destroyDialog(shell.dialog)");
    expect(source).toContain('if (activeValidationCredentialId() !== null) return "A credential validation check is in progress"');
    expect(source).toContain('operationPhase === "validation-in-flight"');
    expect(validationRender).toBeGreaterThan(validation);
    expect(validationAwait).toBeGreaterThan(validationRender);
    expect(removalRender).toBeGreaterThan(removal);
    expect(removalAwait).toBeGreaterThan(removalRender);
    expect(source).toContain('if (result.kind === "unknown")');
    expect(source).toContain("authoritativeStateFresh = false");
  });

  it("restores the busy heading after an unavoidable in-flight dialog close", () => {
    const helper = source.indexOf("function reopenBusyDialog");
    const reopen = source.indexOf("dialog.showModal();", helper);
    const schedule = source.indexOf("requestAnimationFrame(() => {", reopen);
    const recheck = source.indexOf("if (!dialog.isConnected || !dialog.open) return;", schedule);
    const refocus = source.indexOf("dialog.querySelector<HTMLElement>('[data-busy-focus=\"true\"]')?.focus();", recheck);
    expect(helper).toBeGreaterThan(0);
    expect(reopen).toBeGreaterThan(helper);
    expect(schedule).toBeGreaterThan(reopen);
    expect(recheck).toBeGreaterThan(schedule);
    expect(refocus).toBeGreaterThan(recheck);
    expect(source.match(/reopenBusyDialog\(shell\.dialog\);/gu)).toHaveLength(3);
  });

  it("exposes only the authorized Anthropic action and discloses the exact one-shot request before confirmation", () => {
    expect(source).toContain('slot.slotId === "anthropic"');
    expect(source).toContain('authorization?.state === "available"');
    expect(source).toContain('authorization.slotId === "anthropic"');
    expect(source).toContain('if (validationAuthorizationFor(slot) !== null)');
    expect(source).toContain("Confirming starts one validation attempt using the saved credential. One dispatch attempt; no retry.");
    expect(source).toContain('Provider and model: Anthropic, ${authorization.modelId}.');
    expect(source).toContain('only the fixed synthetic phrase “Reply with exactly OK.”');
    expect(source).toContain("Maximum output: four tokens.");
    expect(source).toContain("Standard Anthropic commercial API retention applies; zero-data retention is not claimed.");
    expect(source).toContain("One attempt only. No automatic or hidden retry will occur.");
    expect(source).toContain("will not be displayed");
    expect(source).toContain("Cancel makes no network request and does not consume the one-shot authorization.");
    expect(source).toContain("Confirm consumes the one-shot authorization immediately before credential resolution and possible dispatch.");
    expect(source).toContain("provider effect is limited to 15 seconds within a 20-second host effect deadline");
    expect(source).toContain("local audit-receipt settlement is awaited before completion");
    expect(source).toContain('button("Confirm and validate"');
    expect(source).toContain("awaitValidationSettlement(api.validate");
    expect(source).not.toContain("22_000");
    expect(source).not.toContain("One attempt, up to 10 seconds");
    expect(source).toContain("The one-shot authorization has been consumed. One dispatch attempt, no retry");
    expect(source).toContain("one-shot authorization is consumed. One dispatch attempt, no retry");
  });

  it("distinguishes consumed, expired, and invalid authorization and explains receipt-write success ambiguity", () => {
    expect(source).toContain("a new separately bound authorization is required for any further attempt");
    expect(source).toContain("Anthropic validation authorization expired — a new separately bound authorization is required");
    expect(source).toContain("Anthropic validation authorization invalid — no provider request is available");
    expect(source).toContain("Provider validation succeeded at ${observed}, but its audit receipt could not be saved");
    expect(source).toContain("The one-shot attempt was consumed, no retry will occur");
    const persistedReceiptFailure = source.indexOf('if (latest.outcome === "evidence-incomplete")');
    const genericNondefinitive = source.indexOf("if (!latest.definitive)", persistedReceiptFailure);
    expect(persistedReceiptFailure).toBeGreaterThan(0);
    expect(genericNondefinitive).toBeGreaterThan(persistedReceiptFailure);
    expect(source).toContain('label: "Receipt not saved"');
    expect(source).toContain('latest.receiptState === "mismatch"');
    expect(source).toContain('label: "Receipt not verifiable"');
    expect(source).toContain("the saved audit receipt could not be verified for this build");
    expect(source).toContain("The one-shot attempt was consumed and cannot be retried");
    expect(source).not.toContain('Intl.DateTimeFormat("en-GB"');
    expect(source).toContain("const CREDENTIAL_TIMESTAMP_FORMAT_CONTRACT = Object.freeze");
    expect(source).toContain("locale: document.documentElement.lang");
    expect(source).toContain("CREDENTIAL_TIMESTAMP_FORMAT_CONTRACT.locale");
    expect(source).toContain('dateStyle: "medium", timeStyle: "short"');
  });

  it("focuses the protected field and blocks the rendered surface before an entry mutation awaits", () => {
    const submitting = source.indexOf("submitting = true");
    const mutation = source.indexOf("mutationInFlight = true", submitting);
    const rendered = source.indexOf("render();", mutation);
    const awaited = source.indexOf("await finite(api.save", submitting);
    expect(source).toContain("key.focus();");
    expect(source).toContain('autocomplete: "new-password"');
    expect(source).toContain("name: randomSecretFieldName()");
    expect(source).toContain("crypto.getRandomValues(words)");
    expect(source).toContain("ownershipGroup.disabled = true");
    expect(source).toContain("authorizedField.input.disabled = true");
    expect(source).toContain("clearCorrectedFieldError(authorizedField)");
    expect(source).toContain('const authorizedBy = ownership === "authorized" ? authorizedField.input.value.trim() : ""');
    expect(source).not.toContain('(operation === "save" ? nicknameField.input : key).focus()');
    expect(mutation).toBeGreaterThan(submitting);
    expect(rendered).toBeGreaterThan(mutation);
    expect(awaited).toBeGreaterThan(rendered);
  });

  it("renders only plain-language state facts and visibly blocks unavailable authority", () => {
    expect(source).toContain('"Ownership unavailable"');
    expect(source).toContain('model?.metadataAvailable === false ? "Unavailable"');
    expect(source).toContain("Restore this installation's saved credential details before credential actions");
    expect(source).toContain("Connection and validation details unavailable");
    expect(source).toContain('valid: "Accepted"');
    expect(source).toContain('unauthorized: "Accepted · permission limited"');
    expect(source).toContain('ambiguous: "Inconclusive · unclear result"');
    expect(source).not.toContain("`${slot.validation.outcome}");
    expect(source).toContain("Secure storage recovery is required before credential actions");
    expect(source).toContain('"restore-backup": "replace the unreadable store with its previous encrypted backup');
    expect(source).toContain('rebind: "irreversibly discard every encrypted credential');
    expect(source).not.toContain('model.recovery.actions.join(", ")');
    expect(css).toContain(".btn.danger:disabled { color: var(--disabled); border-color: var(--border); }");
    expect(css).toContain(".btn:disabled, .btn.primary:disabled, .btn.danger:disabled, .btn.danger-fill:disabled { color: GrayText;");
  });

  it("uses provider-wide save grammar, explicit cancellation consequences, and credential terminology", () => {
    expect(source).toContain('`Save credential — ${slot.displayName}`');
    expect(source).not.toContain("Save a ${slot.displayName} credential");
    expect(source).toContain('button("Cancel and close"');
    expect(source).toContain("Cancel closes this secure window. Nothing is saved.");
    expect(source).toContain("changing it later requires removal and re-entry");
    expect(source).toContain('if (operation !== "rotate") shell.body.append(nicknameField.wrap)');
    expect(source).toContain('operation === "reenter" ? nickname : null');
    expect(source).toContain('operation === "reenter" ? ownership : null');
    expect(source).toContain('operation === "reenter" ? authorizedBy : null');
    expect(source).toContain('label: "Credentials can\'t be read"');
    expect(source).toContain('label: "All credentials disabled"');
    expect(source).toContain('? "credential" : "credentials"');
    expect(source).not.toMatch(/Keys can't be read|All keys disabled|\? "key" : "keys"/u);
  });

  it("keeps compact production state textual and gives informational badges and entry dialogs reviewed styling", () => {
    expect(html).toContain('class="prod-label-full">Production disabled</span>');
    expect(html).toContain('class="prod-label-compact" aria-hidden="true">Prod. off</span>');
    expect(css).not.toContain(".prod-state { margin-inline: 3px; text-align: center; font-size: 0;");
    expect(css).toContain(".prod-label-compact { display: inline; }");
    expect(css).toMatch(/\.badge\[data-tone="info"\][^\n]+border-color:/u);
    expect(source).toContain('shell.dialog.classList.add("credential-entry-dialog")');
    expect(css).toContain(".credential-entry-dialog .dialog-body");
  });
});
