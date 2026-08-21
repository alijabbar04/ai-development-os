# `@ai-dev-os/credential-ui`

Electron-free and network-free Stage 18E-H credential management UI. The package
contains finite view-model contracts, truthful projections, a complete refusal
catalogue, and a self-contained browser renderer. The browser renderer imports no
Electron, Node, filesystem, network, provider, policy, or orchestration module.

The renderer never stores a credential in application state. It reads the protected
password input once, clears it synchronously, and passes the local value directly to
the injected typed bridge. Responses never contain secret material or key fragments.

The packaged renderer is exactly three files: `index.html`, `entry.js`, and
`entry.css`. It is intended to load only from `app-credential://entry/index.html`.

Save dialogs use the exact provider-aware title `Save credential — <provider>`.
The window-level cancellation path is labelled “Cancel and close” and states that
nothing is saved. When a shared host state blocks several controls, the renderer
emits one visible global reason and points every affected disabled control to it
with `aria-describedby`; action-specific reasons remain separate.

Clipboard clearing is a fixed default-on, per-operation choice in this bounded
host, not a persisted setting. Nickname entry is supported on first save and on
state-bound re-entry after removal, but rename while a credential is present is
not; a first-class rename action is deferred to the complete Stage 21 application.
