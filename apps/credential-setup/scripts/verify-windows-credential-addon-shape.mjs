import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("windows-native-shape-verifier-requires-windows");

const here = dirname(fileURLToPath(import.meta.url));
const addonPath = join(here, "..", "..", "..", "packages", "secrets-windows", "build", "Release", "ai_dev_os_windows_credential.node");
const addon = createRequire(import.meta.url)(addonPath);
const keys = Reflect.ownKeys(addon);

if (keys.some((key) => typeof key !== "string") || keys.map(String).sort().join(",") !== "availability,read") {
  throw new Error("windows-native-addon-export-shape-mismatch");
}
for (const name of ["availability", "read"]) {
  const descriptor = Object.getOwnPropertyDescriptor(addon, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new Error(`windows-native-addon-export-invalid:${name}`);
  }
}

// Loading the N-API module validates the compiled ABI/link boundary. This
// verifier deliberately never invokes either export, so CredReadW is unreachable.
process.stdout.write("windows-native-addon-shape:ok;credential-manager-calls:0\n");
