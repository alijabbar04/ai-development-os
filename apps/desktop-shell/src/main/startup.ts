import { app, protocol } from "electron";
import { launchDesktopApplication } from "./application.js";
import { registerDesktopProtocolScheme } from "./protocol.js";

registerDesktopProtocolScheme(protocol);

void launchDesktopApplication().catch(() => {
  process.stderr.write("AI Powerhouse could not start safely.\n");
  app.exit(1);
});
