# ADR 0034: Stage 18E-H bootstrap-to-visible startup deadline

Status: Accepted

Date: 2026-08-23

Related: ADR 0019 (Windows-first production scope), ADR 0027 (Stage 18 live
boundary), ADR 0033 (application-owned credential vault and bounded credential
host)

## Context

The externally reviewed Stage 18E-H production-disabled host had a fixed
30-second startup watchdog, but its ownership did not cover the complete startup
interval. The CommonJS package main began a dynamic import before the watchdog
was armed, so a non-settling module load could leave a responsive, windowless
Electron process without a deadline or diagnostic. At the other end, renderer
load completion reported `surface-ready` and cancelled the watchdog before the
hidden BrowserWindow necessarily received `ready-to-show`, completed `show()`,
or reported `isVisible() === true`.

The Opus external review classified both gaps as must-fix findings. The Fable
review otherwise passed the product surface but independently confirmed the
visibility/readiness race as `FR-ADV-01`. A successful observed ordering was not
accepted as proof of the invariant.

## Decision

### 1. One fixed absolute deadline

The credential host owns one non-configurable 30-second deadline from the
CommonJS package-main entry until the intended protected surface is visibly
ready. `startup-bootstrap.cjs` arms the deadline synchronously before loading
the CommonJS runtime and before `loadMain()` can begin its dynamic import.

The controller is a CommonJS module-cache singleton in the trusted main-process
graph. It has no renderer or preload route, environment or argument override,
storage state, reset operation, retry, or alternate timer. The timer is
unreferenced and therefore cannot keep the process alive. A second arm or claim
cannot extend the original absolute interval.

### 2. One ownership handoff and terminal latch

Bootstrap begins in `runtime-binding`, binds the reviewed Electron exit path,
and uses the actual `protocol-registration` phase only while registering the
privileged `app-credential` scheme. The ESM startup task claims the same
controller exactly once. Claiming changes neither the timer nor its original
deadline.

The same terminal latch owns timeout, import rejection, missing or duplicate
handoff, startup rejection, fatal pre-ready process events, diagnostic output,
timer cancellation, and exit. Dynamic-import fulfillment does not cancel the
deadline. A timeout/rejection race cannot emit or exit twice.

Before visible readiness, `unhandledRejection` and `uncaughtException` are
collapsed into the same finite `STARTUP_FAILED` boundary without serializing
the hostile value, message, stack, path, environment, or command line. These
handlers are removed on successful startup so post-ready Electron/Node behavior
is not globally replaced.

### 3. Visible surface is the readiness boundary

`surface-ready` means all of the following are true for the same intended
BrowserWindow:

- renderer loading completed;
- the window is not destroyed;
- the visibility observer was attached before renderer loading;
- the reviewed `ready-to-show` path occurred, or the exact intended window was
  already visible;
- `show()` completed without throwing;
- `isVisible()` reports true;
- the hardened preload and IPC boundary were already installed;
- content protection was applied before any show path.

Renderer load and visibility are fail-fast peers. If close, render-process loss,
show failure, cancellation, or false visibility wins, startup fails or remains
under the one absolute deadline. No second visibility timer and no retry are
introduced. A one-turn `setImmediate` check handles the platform case where
visibility state settles immediately after `show`; it is not a second deadline
and is removed or made inert at terminal settlement.

### 4. Cleanup and launcher interruption

Deadline cancellation and startup-handler disposal occur in the finite
`cleanup` phase. Their failure emits `CLEANUP_FAILED`; a success-shaped phase is
not used for cleanup failure.

On Windows, interrupting the fixed launcher targets only the exact child PID
tree it created, using the system `taskkill.exe` with `/PID`, `/T`, and `/F`.
No name-wide or repository-wide process termination is permitted. Signal
listeners are one-shot and removed after child error or close.

### 5. Packed and unpacked parity

The build copies the CommonJS bootstrap, runtime, and deadline controller
byte-for-byte. The packed verifier requires all three. Its wrapper consumes only
the package entry's `bootstrapStarted` result and does not re-invoke startup.
Temporary `appData` and `userData` overrides remain confined to the disposable
packed test wrapper and are not a production route.

## Consequences

- A non-settling main-module import terminates with one finite timeout.
- A responsive but indefinitely hidden credential process cannot exist after
  watchdog cancellation.
- The normal surface remains hidden until painted, hardened, and visibly ready.
- Startup diagnostics remain terminal-only and contain finite public vocabulary.
- Post-ready fatal events deliberately return to Electron/Node defaults; no
  reachable unowned post-ready production promise was identified.
- The exact-tree interruption regression proves command construction with a
  controlled child mock. A live descendant-tree interruption test remains
  optional supporting evidence, not a production-admission gate.

This decision adds no credential, provider, validation, production, Windows
Credential Manager, Account Manager, clipboard-read, orchestration, or later
stage authority. `AM-02` and `INT-01` remain proven; `ANT-02` and `PLN-02`
remain incomplete; `developmentAccepted=false` and
`productionAdmitted=false` remain unchanged.
