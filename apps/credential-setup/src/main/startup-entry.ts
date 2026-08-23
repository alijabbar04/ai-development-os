import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, clipboard, ipcMain, Menu, safeStorage, session } from "electron";
import { assertAppVaultElectronVersion } from "@ai-dev-os/secrets-app-vault-electron";
import { assertCredentialElectronVersion, CREDENTIAL_SESSION_PARTITION } from "./constants.js";
import { createHardenedCredentialWindow, hardenCredentialSession, installGlobalWebContentsGuard, installMinimalEditMenu, loadCredentialWindow } from "./hardening.js";
import { installCredentialIpc } from "./ipc.js";
import { installCredentialProtocol } from "./protocol.js";
import { createProductionCredentialHost, credentialRendererRoot } from "./production-composition.js";
import { CredentialStartupKnownError, type CredentialStartupPhase } from "./startup-diagnostic.js";
import { launchCredentialSurface, waitForCredentialAppReady } from "./startup-lifecycle.js";

export function exitProductionCredentialHost(code: 1): void {
  app.exit(code);
}

export async function startProductionCredentialHost(setPhase: (phase: CredentialStartupPhase) => void): Promise<void> {
  setPhase("runtime-binding");
  const electronVersion = process.versions["electron"];
  if (electronVersion === undefined) throw new CredentialStartupKnownError("ELECTRON_RUNTIME_REQUIRED");
  try {
    assertAppVaultElectronVersion(electronVersion);
    assertCredentialElectronVersion(electronVersion);
  } catch {
    throw new CredentialStartupKnownError("ELECTRON_VERSION_UNREVIEWED");
  }

  setPhase("protocol-registration");
  setPhase("app-readiness");
  app.setName("AI Development OS Credential Setup");
  installGlobalWebContentsGuard(app);
  if (!app.requestSingleInstanceLock()) throw new CredentialStartupKnownError("SINGLE_INSTANCE_UNAVAILABLE");
  await waitForCredentialAppReady(app);

  setPhase("session-hardening");
  const credentialSession = session.fromPartition(CREDENTIAL_SESSION_PARTITION, { cache: false });
  hardenCredentialSession(credentialSession);
  installCredentialProtocol(credentialSession, credentialRendererRoot(app.getAppPath()));
  installMinimalEditMenu(Menu);

  setPhase("service-composition");
  const token = randomBytes(32).toString("hex");
  const service = await createProductionCredentialHost({ app, clipboard, safeStorage });
  await launchCredentialSurface({
    app,
    service,
    createWindow: async () => await createHardenedCredentialWindow({
      credentialSession,
      preloadPath: join(app.getAppPath(), "dist", "preload", "credential.cjs"),
      sessionToken: token,
    }),
    installIpc: (window, touch) => installCredentialIpc(ipcMain, { token, webContentsId: window.webContents.id, credentialSession, service, window, touch }),
    load: loadCredentialWindow,
    onPhase: setPhase,
  });
}
