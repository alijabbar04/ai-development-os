# AI Development OS saved Windows workspace

This development app saves local projects, accepted briefs, manual plans, attributed AI proposals, exact scope approvals, project stops and planning handovers. It uses one application-owned SQLite store. Adopting a proposed draft does not start a coding task, approve scope or authorise spending.

From the repository root, with Windows x64 Node **24.17.0** and the lockfile dependencies installed:

```powershell
npm run start:desktop
```

The command builds the app, prepares its private hash-pinned Node child runtime, and restores the exact checksummed Electron **43.4.1** runtime if needed. The visible launcher strips inherited Electron, Node and credential controls. It never runs Electron as Node or rebuilds the repository SQLite addon for the Electron ABI. This is a source development launch, not an installer release.

## Saved workflow

The **AI planning** page adds a separate describe → clarify → propose → adopt journey to an existing saved project. The shipped subscription connection currently reports **LIVE_ROUTE_BLOCKED**: the installed vendor CLI's isolation flags do not prove that managed policy helpers cannot execute. No authentication or inference is attempted, and no API billing fallback is offered. A login alone does not resolve that policy boundary. You can still save project information and planning session drafts locally.

When a host-owned route is qualified, its exact model and data categories are shown before every native request confirmation. Only explicitly selected, already saved repository summary data may accompany the typed description, answers and accepted brief. Remaining vendor allowance is unknown; the local cap is three explicitly initiated requests per session and two clarification rounds. Save edits before requesting or accepting a brief, and explicitly adopt a validated proposal through its separate confirmation. Editing titles, objectives and existing acceptance criteria preserves model attribution and the unchanged task/dependency identities.

**Save planning edits** persists the description, answers, understanding and proposed content. Status refresh and presentation changes preserve later typing; unsaved fields are labelled. Saved sessions, requests, proposals and provenance remain accessible after reopening. Request dispatch and terminal outcomes are durable phases outside any long-running database transaction. Ambiguous external outcomes and usage stay unknown without an automatic retry. Stopping or cancelling blocks late-result adoption and does not imply zero provider usage.

1. Create a project, enter its description and local planning budget, and choose one repository through the native folder picker. Inspection reads only bounded manifest metadata and Git HEAD/reference files. It runs no repository command, hook or instruction, and does not verify the referenced Git object or dirty state.
2. Edit the brief candidate, answer any clarification, and accept the exact brief in the separate main-owned confirmation window. Unaccepted candidates stay in memory and are lost on close or service restart.
3. Enter a structured manual plan. Save and prepare it. A required scope request is valid for 24 hours; preparation and approval confirmations show its exact expiry. **Review and approve scope** consumes the exact approval and seals the plan in one transaction. After expiry, use **Refresh scope status**, then **Request scope approval again**. Native confirmation expires the old request, preserves its history and creates a distinct, unapproved request for the unchanged plan. Approve and seal separately before its new expiry. Review content and current request identity come from saved records; renderer text cannot grant authority.
4. Quit and reopen to recover the same saved records and journal. A service loss leaves saved data intact; use **Home > Retry**. An unconfirmed write shows **Observe outcome**. Reconcile it before submitting a new action. Stale or conflicting content requires **Reload** and a fresh review.
5. **Stop project** blocks supported local mutations. **Resume project** restores those operations and starts no process or task. Historical money records with trusted original receipts can accept legal operator reports while stopped or after binding drift; these reports do not change the original approval, amount or consumption count.
6. Export a planning handover and open its saved content. Copy the `returnTemplate` object into a **separate JSON file**, edit that copy and attach it through the native file picker. Preserve the exported handover. Handovers grant no authority and contain no execution IDs. Results remain attributed, untrusted operator reports; stale bindings are displayed explicitly.

The saved SQLite handover document remains authoritative if its exported file changes or becomes unavailable. A file warning appears on the card and viewer; the differing file is preserved, other projects remain accessible and healthy exports can still publish. **Refresh file status** checks the current files again. A confirmed save or observed receipt retains its known result even if files or workspace refresh fail. If saved workspace data fails validation, further changes require a successful reload; this is distinct from an export-file warning. A genuinely uncertain write still requires **Observe outcome** on its exact command; refreshing does not clear it or repeat the command.

Projects, SQLite journals and handover artifacts live beneath `%APPDATA%/AI Development OS/desktop-shell-development/saved-workspace`. Preferences and disposable service transport directories are separate. The child drains operations and closes SQLite before cleanup; unknown live resources are preserved. SQLite uses DELETE journaling with FULL synchronization for acknowledged decisions. An OS lifetime lock permits only one owner of a saved store.

## Boundaries and validation

Normal and Developer presentation have the same actions and authority. The private bridge has finite typed operations; the six HTTP routes remain read-only. The renderer has no Node, filesystem, process, network, descriptor, bearer or generic invoke access. Both workspace and confirmation windows retain sandboxing, context isolation, restrictive CSP and exact sender/frame/session checks. The workspace keeps its 1024x720 minimum, 30-second visible-window deadline and 20-second service readiness deadline.

The real Electron smoke uses an explicitly owned synthetic repository and data root. It exercises the DOM, real main-owned confirmations, the pinned child and SQLite; native folder/result selections and past-money fixture seeding are explicitly synthetic. It covers save/reopen, lost acknowledgment, service loss, stale view, stop/resume, handover/manual return, historical binding drift, scaling, reduced motion and forced colours. Recovery phases use a separate test entry and a fixed synthetic clock, fully closing and reopening the app at expiry; there is no production clock switch. They demonstrate cancelled and confirmed renewal, separate approval, an actual edited export, warnings in both modes, continued saves, exact observation and another full reopen. Additional AI phases use a separate owned synthetic inference child to demonstrate describe/clarify/propose/adopt/reopen through the real inference validation, native confirmation and durable application. Their reports explicitly identify synthetic outputs and zero live invocations. This fixture cannot qualify a subscription connection. The packed-runtime gate installs fresh tarballs and proves the installed pinned child can save, seal and reopen actual SQLite.

Smoke entries configure separate owned Electron `userData` and `sessionData` directories before readiness and before acquiring the real single-instance lock. The normal app retains its existing profile and lock behavior. The smoke first holds one owned profile, verifies that a duplicate is refused, and acquires a different owned profile concurrently. `PROFILE-LOCK-CONTROL.json` records these actual Electron results and owned process exits. This control does not inspect or close an existing user app. Original journey deadlines, native confirmations and authority checks still apply; failed fixture roots and evidence are preserved.

```powershell
npm run smoke:real --workspace @ai-dev-os/desktop-shell
npm run verify:packed-runtime --workspace @ai-dev-os/desktop-shell
```

The shipped live planning route remains blocked pending supported isolation qualification. Quote retrieval, purchases, payments, coding execution, broader production admission, installer release and PLN-02 remain unavailable. Synthetic examples and compatibility fixtures stay outside the production launch entry points.
