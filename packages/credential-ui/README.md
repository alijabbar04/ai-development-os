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
