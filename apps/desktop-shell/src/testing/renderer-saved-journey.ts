export interface RendererSavedJourneyDriver {
  evaluate<T>(script: string): Promise<T>;
  capture(name: string): Promise<void>;
  loseNextReply(): Promise<void>;
  restartService(): Promise<void>;
  waitReady(): Promise<void>;
  progress?(step: string, assertions: Readonly<Record<string, boolean>>): void;
}

const WAIT_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 100;

async function bounded<T>(operation: Promise<T>, label: string, deadlineMs = WAIT_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`RENDERER_SAVED_JOURNEY_TIMEOUT:${label}`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function evaluate<T>(driver: RendererSavedJourneyDriver, script: string, label: string): Promise<T> {
  return await bounded(driver.evaluate<T>(script), label);
}

async function waitFor(driver: RendererSavedJourneyDriver, label: string, predicate: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (await bounded(driver.evaluate<boolean>(predicate), `${label}-predicate`, remaining)) return;
    const delay = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`RENDERER_SAVED_JOURNEY_TIMEOUT:${label}`);
}

function requireAssertion(assertions: Record<string, boolean>, name: string, value: boolean): void {
  assertions[name] = value;
  if (!value) throw new Error(`RENDERER_SAVED_JOURNEY_ASSERTION:${name}`);
}

async function clickExact(driver: RendererSavedJourneyDriver, label: string): Promise<void> {
  const clicked = await evaluate<boolean>(driver, `(() => {
    const control = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)} && !candidate.disabled);
    if (!(control instanceof HTMLButtonElement)) return false;
    control.click();
    return true;
  })()`, `click-${label}`);
  if (!clicked) throw new Error(`RENDERER_SAVED_JOURNEY_CONTROL_UNAVAILABLE:${label}`);
}

async function capture(driver: RendererSavedJourneyDriver, name: string): Promise<void> {
  await bounded(driver.capture(name), `capture-${name}`);
}
function checkpoint(driver: RendererSavedJourneyDriver, step: string, assertions: Record<string, boolean>): void {
  driver.progress?.(step, Object.freeze({ ...assertions }));
}

export async function runRendererHandoverViewerCheck(driver: RendererSavedJourneyDriver, expectedStale: boolean): Promise<Record<string, boolean>> {
  const assertions: Record<string, boolean> = {};
  await waitFor(driver, "saved-handover-view-ready", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Open saved handover" && !control.disabled))()`);
  requireAssertion(assertions, "savedHandoverOpenedFromFocusedControl", await evaluate<boolean>(driver, `(() => {
    const control = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === "Open saved handover" && !candidate.disabled);
    if (!(control instanceof HTMLButtonElement)) return false;
    control.focus();
    if (document.activeElement !== control) return false;
    control.click();
    return true;
  })()`, "open-focused-saved-handover"));
  await waitFor(driver, "saved-handover-view-open", `(() => {
    const dialog = document.querySelector("#detail-dialog");
    return dialog instanceof HTMLDialogElement && dialog.open && document.querySelector(".handover-document")?.textContent?.length > 0;
  })()`);
  const result = await evaluate<{
    title: boolean;
    secondaryPath: boolean;
    authority: boolean;
    stale: boolean;
    exactText: boolean;
    projectBinding: boolean;
    planBinding: boolean;
    inert: boolean;
  }>(driver, `(() => {
    const dialog = document.querySelector("#detail-dialog");
    const title = document.querySelector("#dialog-title")?.textContent?.trim() ?? "";
    const path = document.querySelector("#dialog-content .handover-path");
    const authority = document.querySelector("#dialog-content .status-badge")?.textContent?.trim() ?? "";
    const pre = document.querySelector("#dialog-content .handover-document");
    if (!(dialog instanceof HTMLDialogElement) || !(path instanceof HTMLParagraphElement) || !(pre instanceof HTMLPreElement)) return { title: false, secondaryPath: false, authority: false, stale: false, exactText: false, projectBinding: false, planBinding: false, inert: false };
    let artifact;
    try { artifact = JSON.parse(pre.textContent ?? ""); } catch { return { title: false, secondaryPath: false, authority: false, stale: false, exactText: false, projectBinding: false, planBinding: false, inert: false }; }
    const template = artifact?.returnTemplate;
    const visibleText = pre.textContent ?? "";
    return {
      title: /^Planning handover, revision [1-9][0-9]*$/.test(title),
      secondaryPath: path.textContent?.startsWith("Saved file: ") === true && path.textContent.length > "Saved file: ".length && !Array.from(dialog.querySelectorAll("h3")).some((heading) => heading.textContent === path.textContent),
      authority: authority.startsWith("Authority: none"),
      stale: authority.includes(${JSON.stringify(expectedStale ? "Stale binding" : "Current binding")}),
      exactText: visibleText === JSON.stringify(artifact, null, 2) + "\\n" && artifact?.schemaVersion === 1 && artifact?.kind === "planning-handover" && artifact?.authority === "none",
      projectBinding: typeof artifact?.projectId === "string" && artifact.projectId.length > 0 && template?.projectId === artifact.projectId && template?.handoverId === artifact.handoverId,
      planBinding: typeof artifact?.planId === "string" && artifact.planId.length > 0 && /^[a-f0-9]{64}$/.test(artifact.planDigest) && template?.briefDigest === artifact.briefDigest && template?.planDigest === artifact.planDigest,
      inert: pre.children.length === 0 && dialog.querySelector("script") === null,
    };
  })()`, "inspect-saved-handover");
  requireAssertion(assertions, "savedHandoverTitleAndPathVisible", result.title && result.secondaryPath);
  requireAssertion(assertions, "savedHandoverAuthorityAndStaleLabel", result.authority && result.stale);
  requireAssertion(assertions, "savedHandoverExactArtifactText", result.exactText);
  requireAssertion(assertions, "savedHandoverProjectAndPlanBinding", result.projectBinding && result.planBinding);
  requireAssertion(assertions, "savedHandoverContentInert", result.inert);
  requireAssertion(assertions, "savedHandoverEscapeRequested", await evaluate<boolean>(driver, `(() => {
    const opener = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Open saved handover");
    const dialog = document.querySelector("#detail-dialog");
    if (!(opener instanceof HTMLButtonElement) || !(dialog instanceof HTMLDialogElement)) return false;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  })()`, "escape-saved-handover"));
  await waitFor(driver, "saved-handover-closed-with-focus", `(() => {
    const opener = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Open saved handover");
    return opener instanceof HTMLButtonElement && document.querySelector("#detail-dialog")?.hasAttribute("open") === false && document.activeElement === opener;
  })()`);
  assertions["savedHandoverClosedAndFocusRestored"] = true;
  return { ...assertions };
}

export async function runRendererSavedJourney(driver: RendererSavedJourneyDriver): Promise<Record<string, boolean>> {
  const assertions: Record<string, boolean> = {};
  checkpoint(driver, "starting", assertions);
  await bounded(driver.waitReady(), "initial-ready");
  await waitFor(driver, "home-ready", `(() => document.querySelector("#new-project-name") instanceof HTMLInputElement)()`);
  checkpoint(driver, "home-ready", assertions);

  requireAssertion(assertions, "creationExplainsNativeRepositoryChoice", await evaluate<boolean>(driver, `(() => {
    const form = document.querySelector("#new-project-name")?.closest("form");
    return form?.textContent?.includes("choose the project repository folder") === true;
  })()`, "creation-copy"));

  requireAssertion(assertions, "projectCreationSubmitted", await evaluate<boolean>(driver, `(() => {
    const setValue = (selector, value) => {
      const control = document.querySelector(selector);
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return false;
      control.value = value;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const valuesSet = setValue("#new-project-name", "Garden field journal")
      && setValue("#new-project-objective", "Keep a durable field journal for seasonal garden observations and decisions.")
      && setValue("#new-project-outcomes", "Record daily field observations\\nReview seasonal patterns")
      && setValue("#new-project-budget", "1250.50")
      && setValue("#new-project-currency", "GBP");
    const submit = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Create project" && !control.disabled);
    if (!valuesSet || !(submit instanceof HTMLButtonElement)) return false;
    submit.click();
    return true;
  })()`, "create-project"));
  checkpoint(driver, "project-submitted", assertions);

  await waitFor(driver, "project-created", `(() => Array.from(document.querySelectorAll(".project-row h3")).some((heading) => heading.textContent?.trim() === "Garden field journal"))()`);
  assertions["projectCreated"] = true;
  checkpoint(driver, "project-listed", assertions);
  requireAssertion(assertions, "projectOpened", await evaluate<boolean>(driver, `(() => {
    const row = Array.from(document.querySelectorAll(".project-row")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Garden field journal");
    const open = row?.querySelector("button");
    if (!(open instanceof HTMLButtonElement) || open.disabled) return false;
    open.click();
    return true;
  })()`, "open-created-project"));
  checkpoint(driver, "project-opened", assertions);
  await waitFor(driver, "project-loaded", `(() => document.querySelector("#brief-objective") instanceof HTMLTextAreaElement && document.querySelector(".project-title h2")?.textContent?.trim() === "Garden field journal")()`);
  requireAssertion(assertions, "repositorySelectedDuringCreation", await evaluate<boolean>(driver, `(() => {
    const repository = Array.from(document.querySelectorAll(".card")).find((candidate) => candidate.querySelector("h2")?.textContent?.trim() === "Repository");
    return repository !== undefined && !repository.textContent?.includes("No repository selected");
  })()`, "created-repository"));
  checkpoint(driver, "repository-verified", assertions);
  await capture(driver, "01-saved-project");

  requireAssertion(assertions, "briefCandidateSubmitted", await evaluate<boolean>(driver, `(() => {
    const set = (selector, value) => { const control = document.querySelector(selector); if (!(control instanceof HTMLTextAreaElement)) return false; control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); return true; };
    const ready = set("#brief-objective", "Give gardeners a dependable, searchable record of field conditions, interventions and outcomes.")
      && set("#brief-outcomes", "Capture dated observations\\nCompare seasonal conditions\\nPreserve decisions with their context")
      && set("#brief-non-goals", "Run garden equipment\\nGenerate advice with AI")
      && set("#brief-audiences", "Gardeners\\nSeasonal reviewers");
    const submit = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Prepare brief candidate" && !control.disabled);
    if (!ready || !(submit instanceof HTMLButtonElement)) return false;
    submit.click();
    return true;
  })()`, "draft-brief"));
  checkpoint(driver, "brief-submitted", assertions);
  await waitFor(driver, "brief-candidate", `(() => {
    const candidate = Array.from(document.querySelectorAll(".card")).find((card) => card.querySelector("h2")?.textContent?.trim() === "Brief candidate");
    const accept = Array.from(candidate?.querySelectorAll("button") ?? []).find((control) => control.textContent?.trim() === "Accept this exact brief");
    return candidate?.querySelector("h3")?.textContent?.trim() === "Give gardeners a dependable, searchable record of field conditions, interventions and outcomes." && accept instanceof HTMLButtonElement && !accept.disabled;
  })()`);
  const candidateReady = await evaluate<boolean>(driver, `(() => {
    const accept = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Accept this exact brief");
    if (accept instanceof HTMLButtonElement && !accept.disabled) return true;
    const form = document.querySelector(".clarification-form");
    if (!(form instanceof HTMLFormElement)) return false;
    for (const answer of form.querySelectorAll("textarea")) {
      answer.value = answer.value.trim() || "Use the operator's dated field observations as the source of record.";
      answer.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const apply = Array.from(form.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Apply answers" && !control.disabled);
    if (!(apply instanceof HTMLButtonElement)) return false;
    apply.click();
    return true;
  })()`, "answer-clarifications");
  requireAssertion(assertions, "clarificationsHandled", candidateReady);
  await waitFor(driver, "brief-ready-to-accept", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Accept this exact brief" && !control.disabled))()`);
  await clickExact(driver, "Accept this exact brief");
  await waitFor(driver, "brief-accepted", `(() => Array.from(document.querySelectorAll(".digest")).some((item) => item.textContent?.startsWith("Accepted brief")))()`);
  assertions["briefAccepted"] = true;
  checkpoint(driver, "brief-accepted", assertions);
  await capture(driver, "02-accepted-brief");

  requireAssertion(assertions, "planRouteFocused", await evaluate<boolean>(driver, `(() => {
    const route = document.querySelector('[data-route="plan"]');
    if (!(route instanceof HTMLButtonElement)) return false;
    route.click();
    return document.activeElement?.tagName === "H1";
  })()`, "open-plan"));
  await waitFor(driver, "plan-editor", `(() => document.querySelector("#plan-title") instanceof HTMLInputElement)()`);
  requireAssertion(assertions, "scopeExpansionPlanSubmitted", await evaluate<boolean>(driver, `(() => {
    const add = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Add task" && !control.disabled);
    if (!(add instanceof HTMLButtonElement)) return false;
    add.click();
    const title = document.querySelector("#plan-title");
    const scope = document.querySelector("#plan-scope");
    const tasks = Array.from(document.querySelectorAll(".task-editor"));
    if (!(title instanceof HTMLInputElement) || !(scope instanceof HTMLSelectElement) || tasks.length !== 2) return false;
    title.value = "Garden journal saved workflow";
    scope.value = "scope-expansion";
    const titles = ["Build observation journal", "Verify seasonal review"];
    const objectives = [
      "Store dated entries and retain a deliberately long field note: " + "garden-observation-".repeat(60),
      "Confirm saved entries can be reopened and compared without claiming automated analysis.",
    ];
    const criteria = ["An entry saves with its date\\nThe entry reopens unchanged", "A seasonal view lists saved entries\\nLong notes wrap without horizontal page overflow"];
    tasks.forEach((task, index) => {
      const taskTitle = task.querySelector('[data-task-field="title"]');
      const objective = task.querySelector('[data-task-field="objective"]');
      const acceptance = task.querySelector('[data-task-field="criteria"]');
      if (taskTitle instanceof HTMLInputElement) taskTitle.value = titles[index];
      if (objective instanceof HTMLTextAreaElement) objective.value = objectives[index];
      if (acceptance instanceof HTMLTextAreaElement) acceptance.value = criteria[index];
    });
    const save = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Save plan draft" && !control.disabled);
    if (!(save instanceof HTMLButtonElement)) return false;
    save.click();
    return true;
  })()`, "save-plan"));
  await waitFor(driver, "plan-saved", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Prepare plan" && !control.disabled))()`);
  assertions["planSaved"] = true;
  checkpoint(driver, "plan-saved", assertions);
  await clickExact(driver, "Prepare plan");
  await waitFor(driver, "scope-awaiting-approval", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Review and approve scope" && !control.disabled))()`);
  assertions["scopePrepared"] = true;
  await clickExact(driver, "Review and approve scope");
  await waitFor(driver, "scope-approved-and-sealed", `(() => document.body.textContent?.includes("This plan is sealed.") === true)()`);
  assertions["scopeApproved"] = true;
  assertions["planSealed"] = true;
  checkpoint(driver, "plan-sealed", assertions);
  await capture(driver, "03-sealed-plan");

  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="handovers"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "open-handovers");
  await waitFor(driver, "handover-page", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Export handover" && !control.disabled))()`);
  await bounded(driver.loseNextReply(), "arm-lost-reply");
  await clickExact(driver, "Export handover");
  await waitFor(driver, "unknown-export", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Observe outcome" && !control.disabled))()`);
  assertions["unknownAcknowledgementShown"] = true;
  checkpoint(driver, "unknown-export-visible", assertions);
  requireAssertion(assertions, "unknownBlocksNewMutations", await evaluate<boolean>(driver, `(() => {
    const exportButton = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Export handover");
    return exportButton instanceof HTMLButtonElement && exportButton.disabled;
  })()`, "unknown-blocks-mutations"));
  await capture(driver, "04-unknown-export");
  await clickExact(driver, "Observe outcome");
  await waitFor(driver, "export-observed", `(() => document.querySelector(".record") !== null && Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Open returned handover and attach result" && !control.disabled))()`);
  assertions["exactUnknownCommandObserved"] = true;
  assertions["handoverExported"] = true;
  Object.assign(assertions, await runRendererHandoverViewerCheck(driver, false));
  checkpoint(driver, "saved-handover-viewed", assertions);
  await clickExact(driver, "Open returned handover and attach result");
  await waitFor(driver, "result-attached", `(() => document.querySelector(".manual-result") !== null)()`);
  assertions["manualResultAttached"] = true;
  requireAssertion(assertions, "manualResultMarkedUntrusted", await evaluate<boolean>(driver, `(() => document.querySelector(".manual-result")?.previousElementSibling?.textContent?.includes("untrusted") === true)()`, "result-attribution"));
  checkpoint(driver, "handover-result-attached", assertions);
  await capture(driver, "05-untrusted-result");

  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="approvals"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "open-history");
  await waitFor(driver, "history-page", `(() => Array.from(document.querySelectorAll("h2")).some((heading) => heading.textContent?.trim() === "Project history"))()`);
  assertions["projectHistoryViewed"] = true;
  await waitFor(driver, "stop-available", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Stop project" && !control.disabled))()`);
  await clickExact(driver, "Stop project");
  await waitFor(driver, "project-stopped", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Resume project" && !control.disabled))()`);
  assertions["projectStopped"] = true;
  await capture(driver, "06-stopped-project");
  await clickExact(driver, "Resume project");
  await waitFor(driver, "project-resumed", `(() => Array.from(document.querySelectorAll("button")).some((control) => control.textContent?.trim() === "Stop project" && !control.disabled))()`);
  assertions["projectResumed"] = true;
  checkpoint(driver, "stop-resume-complete", assertions);

  await bounded(driver.restartService(), "restart-service");
  await bounded(driver.waitReady(), "restart-ready");
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="home"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "reopen-home");
  await waitFor(driver, "saved-project-after-restart", `(() => Array.from(document.querySelectorAll(".project-row h3")).some((heading) => heading.textContent?.trim() === "Garden field journal"))()`);
  requireAssertion(assertions, "savedProjectReopenedAfterServiceRestart", await evaluate<boolean>(driver, `(() => {
    const row = Array.from(document.querySelectorAll(".project-row")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Garden field journal");
    const open = row?.querySelector("button");
    if (!(open instanceof HTMLButtonElement) || open.disabled) return false;
    open.click();
    return true;
  })()`, "reopen-project"));
  await waitFor(driver, "accepted-brief-reopened", `(() => Array.from(document.querySelectorAll(".digest")).some((item) => item.textContent?.startsWith("Accepted brief")))()`);
  assertions["acceptedBriefReopened"] = true;
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="plan"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "reopen-plan");
  await waitFor(driver, "sealed-plan-reopened", `(() => document.body.textContent?.includes("This plan is sealed.") === true)()`);
  assertions["sealedPlanReopened"] = true;
  checkpoint(driver, "service-restart-persistence-verified", assertions);
  await capture(driver, "07-reopened-project");

  requireAssertion(assertions, "settingsRouteFocused", await evaluate<boolean>(driver, `(() => {
    const route = document.querySelector('[data-route="settings"]');
    if (!(route instanceof HTMLButtonElement)) return false;
    route.click();
    return document.activeElement?.tagName === "H1";
  })()`, "open-settings"));
  await waitFor(driver, "settings-ready", `(() => document.querySelector("#text-scale") instanceof HTMLSelectElement)()`);
  requireAssertion(assertions, "largeTextRequested", await evaluate<boolean>(driver, `(() => {
    const scale = document.querySelector("#text-scale");
    if (!(scale instanceof HTMLSelectElement)) return false;
    scale.value = "large";
    scale.dispatchEvent(new Event("change", { bubbles: true }));
    const save = Array.from(document.querySelectorAll("button")).find((control) => control.textContent?.trim() === "Save presentation settings" && !control.disabled);
    if (!(save instanceof HTMLButtonElement)) return false;
    save.click();
    return true;
  })()`, "set-large-text"));
  await waitFor(driver, "large-text-applied", `(() => document.body.dataset.textScale === "large")()`);
  assertions["largeTextApplied"] = true;
  requireAssertion(assertions, "longTextAndScaledLayoutFit", await evaluate<boolean>(driver, `(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth)()`, "scaled-layout-fit"));
  const mediaContracts = await evaluate<{ reducedMotion: boolean; forcedColors: boolean }>(driver, `(() => {
    const css = Array.from(document.styleSheets).flatMap((sheet) => {
      try { return Array.from(sheet.cssRules || []); } catch { return []; }
    }).map((rule) => rule.cssText).join("\\n");
    return { reducedMotion: css.includes("prefers-reduced-motion"), forcedColors: css.includes("forced-colors") };
  })()`, "media-contracts");
  requireAssertion(assertions, "reducedMotionContractLoaded", mediaContracts.reducedMotion);
  requireAssertion(assertions, "forcedColorsContractLoaded", mediaContracts.forcedColors);
  checkpoint(driver, "presentation-verified", assertions);
  await capture(driver, "08-large-text");

  return { ...assertions };
}

export async function runRendererHistoricalJourney(driver: RendererSavedJourneyDriver, projectName: string): Promise<Record<string, boolean>> {
  const assertions: Record<string, boolean> = {};
  checkpoint(driver, "historical-starting", assertions);
  await bounded(driver.waitReady(), "historical-ready");
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="home"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "historical-home");
  await waitFor(driver, "historical-project-listed", `(() => Array.from(document.querySelectorAll(".project-row h3")).some((heading) => heading.textContent?.trim() === ${JSON.stringify(projectName)}))()`);
  requireAssertion(assertions, "historicalProjectOpened", await evaluate<boolean>(driver, `(() => {
    const row = Array.from(document.querySelectorAll(".project-row")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === ${JSON.stringify(projectName)});
    const open = row?.querySelector("button"); if (!(open instanceof HTMLButtonElement) || open.disabled) return false; open.click(); return true;
  })()`, "historical-open-project"));
  await waitFor(driver, "historical-project-loaded", `(() => document.querySelector(".project-title h2")?.textContent?.trim() === ${JSON.stringify(projectName)})()`);
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="approvals"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "historical-approvals");
  await waitFor(driver, "historical-record-ready", `(() => Array.from(document.querySelectorAll(".record")).some((record) => record.querySelector("h3")?.textContent?.trim() === "Historical money record"))()`);
  requireAssertion(assertions, "stoppedAndBindingDriftVisible", await evaluate<boolean>(driver, `(() => {
    const record = Array.from(document.querySelectorAll(".record")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Historical money record");
    return document.body.textContent?.includes("This project is stopped") === true && record?.textContent?.includes("bindings have changed") === true && record.textContent.includes("operations are stopped");
  })()`, "historical-context"));
  requireAssertion(assertions, "historicalReportActionEnabledWhileStopped", await evaluate<boolean>(driver, `(() => {
    const record = Array.from(document.querySelectorAll(".record")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Historical money record");
    const control = Array.from(record?.querySelectorAll("button") ?? []).find((button) => button.textContent?.trim() === "Report past execution");
    if (!(control instanceof HTMLButtonElement) || control.disabled) return false; control.click(); return true;
  })()`, "historical-report-executed"));
  checkpoint(driver, "historical-report-submitted", assertions);
  await waitFor(driver, "historical-receipt-ready", `(() => {
    const record = Array.from(document.querySelectorAll(".record")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Historical money record");
    const control = Array.from(record?.querySelectorAll("button") ?? []).find((button) => button.textContent?.trim() === "Record receipt");
    return control instanceof HTMLButtonElement && !control.disabled && record?.querySelector('input[placeholder="Manual receipt reference 1"]') instanceof HTMLInputElement;
  })()`);
  requireAssertion(assertions, "manualReceiptSubmitted", await evaluate<boolean>(driver, `(() => {
    const record = Array.from(document.querySelectorAll(".record")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Historical money record");
    const input = record?.querySelector('input[placeholder="Manual receipt reference 1"]');
    const control = Array.from(record?.querySelectorAll("button") ?? []).find((button) => button.textContent?.trim() === "Record receipt");
    if (!(input instanceof HTMLInputElement) || !(control instanceof HTMLButtonElement) || control.disabled) return false;
    input.value = "Manual receipt reference 1"; input.dispatchEvent(new Event("input", { bubbles: true })); control.click(); return true;
  })()`, "historical-record-receipt"));
  checkpoint(driver, "historical-receipt-submitted", assertions);
  await waitFor(driver, "historical-reconciled", `(() => {
    const record = Array.from(document.querySelectorAll(".record")).find((candidate) => candidate.querySelector("h3")?.textContent?.trim() === "Historical money record");
    const actionLabels = new Set(["Report past execution", "Record receipt", "Withdraw historical request"]);
    return record?.querySelector(".status-badge")?.textContent?.trim().toLowerCase() === "reconciled" && !Array.from(record.querySelectorAll("button")).some((button) => actionLabels.has(button.textContent?.trim() ?? ""));
  })()`);
  assertions["historicalSpendingReconciled"] = true;
  assertions["projectStillStoppedAfterHistory"] = await evaluate<boolean>(driver, `(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Resume project" && !button.disabled))()`, "historical-still-stopped");
  requireAssertion(assertions, "projectStillStoppedAfterHistory", assertions["projectStillStoppedAfterHistory"] === true);
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="handovers"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "historical-handovers");
  Object.assign(assertions, await runRendererHandoverViewerCheck(driver, true));
  requireAssertion(assertions, "savedHandoverAvailableWhileStopped", await evaluate<boolean>(driver, `(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Open saved handover" && !button.disabled))()`, "stopped-handover-available"));
  await evaluate<boolean>(driver, `(() => { const route = document.querySelector('[data-route="approvals"]'); if (!(route instanceof HTMLButtonElement)) return false; route.click(); return true; })()`, "historical-return-approvals");
  await waitFor(driver, "historical-stopped-returned", `(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Resume project" && !button.disabled))()`);
  checkpoint(driver, "historical-reconciled", assertions);
  await capture(driver, "07-historical-stopped");
  return { ...assertions };
}
