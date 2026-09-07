# AI Development OS desktop shell

This package is the first development-only Windows workspace for **AI Powerhouse**. It opens a hardened Electron window, starts one disposable child control service owned by that window, verifies the service through the published nonce-before-bearer adoption flow, and then closes the verification connection. The status shown in the UI is an observation with an age, not a claim that a socket remains connected.

From the repository root:

```powershell
npm run start:desktop
```

The first-light journey provides Home, Projects, Approvals, Usage, and Settings. Project intake, brief revisions, plans, and approvals are isolated synthetic examples. Example interactions update memory only and deliberately do not save a project, approve scope, run a task, contact a provider, or access credentials.

## Architecture and authority

- Electron main owns the child process, its unique runtime directory, adoption verification, benign preferences, lifecycle, and cleanup.
- The child imports the public `startControlService` API and receives an empty, explicitly synthetic projection dataset. It has no provider, project, credential, account, task, repository, or operator data.
- Preload exposes a finite frozen bridge. The renderer has no Node, filesystem, process, network, descriptor, nonce, bearer, or generic invoke access.
- A custom protocol serves an exact asset allowlist with `connect-src 'none'`. The window is sandboxed, context-isolated, Node-disabled, popup/navigation/permission-denied, and fixed to Electron 43.4.1.
- Normal and Developer presentation use the control service's existing mode vocabulary and have identical `authority: "none"` and empty command sets. Changing presentation restarts only this app's owned synthetic service. Developer presentation adds received diagnostics, not verbs or authority.
- Only `presentationMode`, `textScale`, and first-launch acknowledgement are persisted beneath this app's dedicated development data root. There is no project/draft/approval database and no secret entry.
- The 30-second visible-window and 20-second service-ready deadlines are constants. A failed first start does not offer recovery before the readiness deadline. At the deadline it offers Relaunch, Quit, and Open read-only; read-only is disabled unless a genuine cached safe observation exists.

The presentation adapter uses type-only `Pick` contracts from the public C6 `ProjectBrief`, `ProjectSummaryProjection`, `ProjectPlan`, and `ApprovalRequest` types plus the public C9 plan action type. A later application owner can supply real, already-projected inputs without replacing renderer components. That later owner must compose durable C7/C8/C9/C10 application operations and exact authority checks; this shell intentionally invents no project endpoints or write commands.

No new third-party dependency was introduced. Electron 43.4.1 and the control-service/Fastify graph were already pinned in the accepted base; the added workspace only reuses them.
