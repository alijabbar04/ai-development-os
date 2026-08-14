import { createRequire } from "node:module";
import { types } from "node:util";
import { SecretBrokerError } from "@ai-dev-os/secrets";
import type {
  WindowsCredentialNativeAvailability,
  WindowsCredentialAbortSignal,
  WindowsCredentialNativePort,
  WindowsCredentialNativeReadResult,
} from "./contracts.js";

interface NativeAddon {
  availability(targetName: string): Promise<WindowsCredentialNativeAvailability>;
  read(targetName: string): Promise<WindowsCredentialNativeReadResult>;
}

type NativeAddonLoader = () => unknown;

function isAborted(signal: WindowsCredentialAbortSignal | undefined): boolean {
  try { return signal?.aborted === true; }
  catch { throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution cancellation state is unavailable."); }
}

function zeroOwnResultBytes(value: unknown): void {
  try {
    if (typeof value === "object" && value !== null && !types.isProxy(value) && value instanceof Uint8Array) {
      Reflect.apply(Uint8Array.prototype.fill, value, [0]);
    }
    if (typeof value !== "object" || value === null || types.isProxy(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "bytes");
    if (descriptor !== undefined && "value" in descriptor && !types.isProxy(descriptor.value) && descriptor.value instanceof Uint8Array) {
      Reflect.apply(Uint8Array.prototype.fill, descriptor.value, [0]);
    }
  } catch { /* an uninspectable result never reaches the caller */ }
}

function loadAddon(loader: NativeAddonLoader): NativeAddon {
  try {
    const loaded = loader();
    if (typeof loaded !== "object" || loaded === null) throw new Error("invalid-addon");
    const descriptors = Object.getOwnPropertyDescriptors(loaded);
    const availability = descriptors["availability"]?.value;
    const read = descriptors["read"]?.value;
    if (typeof availability !== "function" || typeof read !== "function") throw new Error("invalid-addon");
    return Object.freeze({
      availability: (targetName: string) => Reflect.apply(availability, loaded, [targetName]) as Promise<WindowsCredentialNativeAvailability>,
      read: (targetName: string) => Reflect.apply(read, loaded, [targetName]) as Promise<WindowsCredentialNativeReadResult>,
    });
  } catch {
    throw new SecretBrokerError("UNAVAILABLE", "The Windows credential native boundary is unavailable.");
  }
}

export function createWindowsCredentialNativePortFromLoader(
  platform: string,
  loader: NativeAddonLoader,
): WindowsCredentialNativePort {
  let captured: NativeAddon | null = null;
  function addon(): NativeAddon {
    if (platform !== "win32") {
      throw new SecretBrokerError("UNAVAILABLE", "The Windows credential backend is unavailable on this platform.");
    }
    captured ??= loadAddon(loader);
    return captured;
  }
  return Object.freeze({
    async availability(targetName: string, signal?: WindowsCredentialAbortSignal) {
      if (isAborted(signal)) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
      let result: WindowsCredentialNativeAvailability;
      try { result = await addon().availability(targetName); }
      catch (error) { zeroOwnResultBytes(error); throw error; }
      try {
        if (isAborted(signal)) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
      } catch (error) { zeroOwnResultBytes(result); throw error; }
      return result;
    },
    async read(targetName: string, signal?: WindowsCredentialAbortSignal) {
      if (isAborted(signal)) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
      let result: WindowsCredentialNativeReadResult;
      try { result = await addon().read(targetName); }
      catch (error) { zeroOwnResultBytes(error); throw error; }
      try {
        if (isAborted(signal)) throw new SecretBrokerError("RESOLUTION_TIMEOUT", "The secret resolution was cancelled.");
      } catch (error) { zeroOwnResultBytes(result); throw error; }
      return result;
    },
  });
}

export function createRealWindowsCredentialNativePort(): WindowsCredentialNativePort {
  const require = createRequire(import.meta.url);
  return createWindowsCredentialNativePortFromLoader(
    process.platform,
    () => require("../build/Release/ai_dev_os_windows_credential.node"),
  );
}
