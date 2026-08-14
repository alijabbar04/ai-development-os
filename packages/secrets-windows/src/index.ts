import { createWindowsCredentialSecretBrokerInternal, parseProductionOptions } from "./broker.js";
import { createRealWindowsCredentialNativePort } from "./real-native.js";

export {
  WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION,
  WINDOWS_CREDENTIAL_MAX_SECRET_BYTES,
  WINDOWS_CREDENTIAL_TARGET_PREFIX,
  type WindowsCredentialBrokerOptions,
  type WindowsCredentialSecretBroker,
  type WindowsCredentialTargetBinding,
} from "./contracts.js";

export function createWindowsCredentialSecretBroker(options: unknown) {
  return createWindowsCredentialSecretBrokerInternal(Object.freeze({
    ...parseProductionOptions(options),
    native: createRealWindowsCredentialNativePort(),
  }));
}
