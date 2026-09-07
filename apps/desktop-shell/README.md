# AI Development OS saved Windows workspace

This development app saves local projects, accepted briefs, manually edited plans, exact scope approvals, project stops and planning handovers. It uses one application-owned SQLite store. It does not launch AI tasks or spend money.

From the repository root, with Windows x64 Node **24.17.0** and the lockfile dependencies installed:

```powershell
npm run start:desktop
```

The command builds the app, prepares its private hash-pinned Node child runtime, and restores the exact checksummed Electron **43.4.1** runtime if needed. The visible launcher strips inherited Electron, Node and credential controls. It never runs Electron as Node or rebuilds the repository SQLite addon for the Electron ABI. This is a source development launch, not an installer release.

## Saved workflow

1. Create a project, enter its description and local planning budget, and choose one repository through the native folder picker. Inspection reads only bounded manifest metadata and Git HEAD/reference files. It runs no repository command, hook or instruction, and does not verify the referenced Git object or dirty state.
2. Edit the brief candidate, answer any clarification, and accept the exact brief in the separate main-owned confirmation window. Unaccepted candidates stay in memory and are lost on close or service restart.
3. Enter a structured manual plan. Save and prepare it. Required scope approval consumes the exact approval and seals the plan in one transaction. Review content comes from saved records; renderer text cannot grant authority.
4. Quit and reopen to recover the same saved records and journal. A service loss leaves saved data intact; use **Home > Retry**. An unconfirmed write shows **Observe outcome**. Reconcile it before submitting a new action. Stale or conflicting content requires **Reload** and a fresh review.
5. **Stop project** blocks supported local mutations. **Resume project** restores those operations and starts no process or task. Historical money records with trusted original receipts can accept legal operator reports while stopped or after binding drift; these reports do not change the original approval, amount or consumption count.
6. Export a planning handover, reopen its saved content, and use its return template to attach a manually supplied JSON result through the native file picker. Handovers grant no authority and contain no execution IDs. Results remain attributed, untrusted operator reports; stale bindings are displayed explicitly.

Projects, SQLite journals and handover artifacts live beneath `%APPDATA%/AI Development OS/desktop-shell-development/saved-workspace`. Preferences and disposable service transport directories are separate. The child drains operations and closes SQLite before cleanup; unknown live resources are preserved. SQLite uses DELETE journaling with FULL synchronization for acknowledged decisions. An OS lifetime lock permits only one owner of a saved store.

## Boundaries and validation

Normal and Developer presentation have the same actions and authority. The private bridge has finite typed operations; the six HTTP routes remain read-only. The renderer has no Node, filesystem, process, network, descriptor, bearer or generic invoke access. Both workspace and confirmation windows retain sandboxing, context isolation, restrictive CSP and exact sender/frame/session checks. The workspace keeps its 1024x720 minimum, 30-second visible-window deadline and 20-second service readiness deadline.

The real Electron smoke uses an explicitly owned synthetic repository and data root. It exercises the DOM, real main-owned confirmations, the pinned child and SQLite; native folder/result selections and past-money fixture seeding are explicitly synthetic. It covers save/reopen, lost acknowledgment, service loss, stale view, stop/resume, handover/manual return, historical binding drift, scaling, reduced motion and forced colours. The packed-runtime gate installs fresh tarballs and proves the installed pinned child can save, seal and reopen actual SQLite.

```powershell
npm run smoke:real --workspace @ai-dev-os/desktop-shell
npm run verify:packed-runtime --workspace @ai-dev-os/desktop-shell
```

Planning is manual. Provider access, live usage, quote retrieval, purchases, payments, AI task execution, production admission, installer release and PLN-02 remain unavailable. Synthetic examples and compatibility fixtures stay outside the saved workflow production entry points.
