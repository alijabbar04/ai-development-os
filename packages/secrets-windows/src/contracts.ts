import type {
  SecretAuditHook,
  SecretBroker,
  SecretClock,
  SecretRef,
} from "@ai-dev-os/secrets";

export interface WindowsCredentialAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

export const WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION = 1 as const;
export const WINDOWS_CREDENTIAL_TARGET_PREFIX = "AI-Dev-OS:v1" as const;
export const WINDOWS_CREDENTIAL_MAX_SECRET_BYTES = 16_384 as const;

export interface WindowsCredentialBrokerOptions {
  readonly schemaVersion: typeof WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION;
  readonly reference: SecretRef;
  readonly clock: SecretClock;
  readonly audit?: SecretAuditHook;
}

export interface WindowsCredentialTargetBinding {
  readonly schemaVersion: typeof WINDOWS_CREDENTIAL_BROKER_SCHEMA_VERSION;
  readonly targetName: string;
  readonly targetFingerprint: string;
  readonly referenceFingerprint: string;
}

export type WindowsCredentialNativeStatus =
  | "ok"
  | "not-found"
  | "access-denied"
  | "unavailable"
  | "malformed"
  | "failure";

export type WindowsCredentialNativeAvailability = Readonly<{
  status: WindowsCredentialNativeStatus;
}>;

export type WindowsCredentialNativeReadResult =
  | Readonly<{ status: "ok"; bytes: Uint8Array }>
  | Readonly<{ status: Exclude<WindowsCredentialNativeStatus, "ok"> }>;

export interface WindowsCredentialNativePort {
  availability(targetName: string, signal?: WindowsCredentialAbortSignal): Promise<WindowsCredentialNativeAvailability>;
  read(targetName: string, signal?: WindowsCredentialAbortSignal): Promise<WindowsCredentialNativeReadResult>;
}

export interface WindowsCredentialSecretBroker extends SecretBroker {
  describeTargetBinding(): WindowsCredentialTargetBinding;
}

export interface WindowsCredentialTestingOptions extends WindowsCredentialBrokerOptions {
  readonly native: WindowsCredentialNativePort;
  readonly onZero?: (record: Readonly<{
    stage: "native-copy" | "material-copy";
    byteLength: number;
    allZero: boolean;
  }>) => void;
}
