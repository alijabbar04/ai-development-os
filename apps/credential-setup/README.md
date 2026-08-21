# Stage 18E-H credential setup host

This is a production-disabled Windows Electron host for the exact committed Stage
18E application-owned vault. It loads only the three packaged credential UI files
through `app-credential://entry/index.html`, has no renderer network capability,
and exposes no read, reveal, copy, export, ciphertext, generic IPC, shell, process,
or development-server surface.

## Bounded IPC reconciliation

The six reviewed `credential-vault:*` channel names are preserved. The accepted UX
requires flat primitive inputs that the earlier IPC draft omitted: ownership,
authorising label, per-save clipboard choice, opaque credential identity, current
record revision/token, and durable enable state. Those inputs are therefore a
bounded schema extension. Enable/disable shares the reviewed non-secret
`credential-vault:remove` mutation channel with a closed `action` discriminator;
it is not a generic dispatcher. Main rechecks the authoritative slot, revision,
identity, and record token before every action.

The validation success envelope is also extended with finite, nonsecret effect
facts: whether the provider request was dispatched, whether its absolute deadline
expired, whether the underlying credential/transport work has settled, whether
the result and Activity sentence were durably recorded, and whether the checked
version is still current, discarded, or unconfirmed. Once dispatch occurs, later
local failures cannot be presented as a pre-effect refusal and never cause an
automatic retry. A deadline response does not release the global validation guard
or host close drain while secret-derived work is still settling.

The UI may switch Normal/Developer presentation locally because the reviewed six
channels deliberately include no event or mode-setting channel. Developer facts
are finite nonsecret values already returned by `describe`; the independently
captured action sets are identical in both modes.

## Safety and project status

- Production is disabled and live validation is disabled.
- Electron is an exact-pinned development peer. `ensure:electron` explicitly
  restores and verifies the checksummed 43.4.1 runtime when its local dist is absent;
  the package does not rely on a nonexistent Electron lifecycle hook.
- Saving never invokes validation.
- Main refuses a nickname or authorising label that directly, compositionally, or
  through the reviewed bounded reversible forms represents the submitted
  credential. The strict at-rest metadata parser applies the same generic
  credential-shape rule to those forms.
- The production host constructs only the committed vault manager/brokers and a
  policy-aware resolver.
- Hosted Windows CI compiles and loads the inherited Credential Manager addon only
  to inspect its exact export shape. It invokes neither export and performs no
  Credential Manager lookup; the foundation's separately authorized native smoke
  is not rerun by this checkpoint.
- Deterministic validation and memory-vault ports exist only for tests and the
  disposable synthetic Electron smoke.
- No installer, updater, provider login, credential export, or Stage 20/21 runtime
  capability is included.
- Clipboard clearing is fixed default-on for each host opening and remains a
  per-operation choice. This version has no persisted clipboard setting. Nicknames
  have no rename action while a credential is present; after removal, the existing
  identity-bound re-entry path accepts corrected entry metadata. A standalone
  rename control remains deferred to Stage 21.
- AM-02 and INT-01 remain proven; ANT-02 and PLN-02 remain incomplete;
  `developmentAccepted=false`, `productionAdmitted=false`, and Stage 20A remains
  ineligible.

## Screenshot evidence

`npm run smoke:real --workspace @ai-dev-os/credential-setup` writes its preview
only inside the reported disposable smoke root. It never updates tracked evidence.
After all renderer changes are final, the committed Stage 18E-H screenshot can be
updated only with:

```powershell
npm run regenerate:credential-host-evidence-screenshot
```

The wrapper accepts no custom destination and refuses extra, duplicate, or mixed
arguments. The evidence command still uses synthetic values and does not authorize
a provider call, Credential Manager access, or production activation.
