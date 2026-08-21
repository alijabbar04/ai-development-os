import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, clipboard, ipcMain, Menu, protocol, safeStorage, session } from "electron";
import { assertAppVaultElectronVersion } from "@ai-dev-os/secrets-app-vault-electron";
import { assertCredentialElectronVersion, CREDENTIAL_PROTOCOL, CREDENTIAL_SESSION_PARTITION } from "./constants.js";
import { createHardenedCredentialWindow, hardenCredentialSession, installGlobalWebContentsGuard, installMinimalEditMenu, loadCredentialWindow } from "./hardening.js";
import { installCredentialIpc } from "./ipc.js";
import { installCredentialProtocol } from "./protocol.js";
import { createProductionCredentialHost, credentialRendererRoot } from "./production-composition.js";
import { launchCredentialSurface } from "./startup-lifecycle.js";

const electronVersion = process.versions["electron"];
if (electronVersion === undefined) throw new Error("ELECTRON_RUNTIME_REQUIRED");
assertAppVaultElectronVersion(electronVersion);
assertCredentialElectronVersion(electronVersion);

protocol.registerSchemesAsPrivileged([{
  scheme: CREDENTIAL_PROTOCOL,
  privileges: { standard: true, secure: true },
}]);

app.setName("AI Development OS Credential Setup");
installGlobalWebContentsGuard(app);

async function startCredentialHost(): Promise<void> {
  await app.whenReady();
  const credentialSession = session.fromPartition(CREDENTIAL_SESSION_PARTITION, { cache: false });
  hardenCredentialSession(credentialSession);
  installCredentialProtocol(credentialSession, credentialRendererRoot(app.getAppPath()));
  installMinimalEditMenu(Menu);

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
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else void startCredentialHost().catch(() => { app.exit(1); });
