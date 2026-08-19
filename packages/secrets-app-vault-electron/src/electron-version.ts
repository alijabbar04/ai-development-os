import { AppVaultError } from "@ai-dev-os/secrets-app-vault";

export const APP_VAULT_ELECTRON_FLOOR = "42.4.1" as const;

function tuple(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron runtime version is malformed.");
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron runtime version is malformed.");
  return parts;
}

export function assertAppVaultElectronVersion(value: string): void {
  const actual = tuple(value);
  const floor = tuple(APP_VAULT_ELECTRON_FLOOR);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > floor[index]!) return;
    if (actual[index]! < floor[index]!) throw new AppVaultError("INVALID_CONFIGURATION", "The Electron runtime does not support the required asynchronous secure-storage boundary.");
  }
}
