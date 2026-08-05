/**
 * Platform sandbox backends.
 *
 * These are the seams where a real operating-system boundary plugs in. Each
 * one probes for the primitive it would need and reports precisely what is
 * missing. None of them claims to be secure, because none of them implements
 * enforcement yet, and a backend that claimed `secure-enforcing` without
 * enforcing anything would defeat the production gate it is supposed to pass.
 *
 * The gate is the point. Refusing to run autonomously on a machine with no
 * sandbox is the correct behaviour; pretending each platform is already
 * contained is not.
 *
 * Installing Docker, WSL, bubblewrap, a hypervisor, a kernel module, or a
 * privileged helper is out of scope for this package. Probing is read-only.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { ProcessBrokerError } from "./errors.js";
import {
  BACKEND_DESCRIPTOR_SCHEMA_VERSION,
  noQuotaSupport,
  parseBackendDescriptor,
  type BackendAvailability,
  type BackendDescriptor,
  type BackendKind,
  type BackendProcess,
  type SandboxBackend,
  type SandboxSession,
} from "./backend.js";
import type { CapabilityGrant } from "./grant.js";

/**
 * What a Windows implementation must provide before it may be classified
 * `secure-enforcing`:
 *
 *   - a restricted access token or an AppContainer/Job-Object identity, so the
 *     workload does not run with the operator's rights
 *   - a Job Object owning the tree, with kill-on-close, so termination is
 *     certain rather than best effort
 *   - filesystem containment through ACLs or a mounted, restricted volume,
 *     including correct handling of junctions, reparse points, drive-relative
 *     paths, UNC and device paths, and alternate data streams
 *   - network restriction (a firewall profile or an AppContainer capability)
 *   - handle-inheritance control and child-process creation limits
 *   - a profile and environment separate from the operator's
 *
 * A Job Object alone bounds the tree; it does not bound the filesystem, the
 * token, or the network, so it is not by itself a sandbox.
 */
export const WINDOWS_BACKEND_ID = "windows-restricted-job-object";

/**
 * What a Linux implementation must provide:
 *
 *   - user, mount, PID, and network namespaces, or an equivalently hardened
 *     container boundary
 *   - a distinct unprivileged identity
 *   - read-only base mounts with an explicit writable set
 *   - cgroup v2 limits for CPU, memory, and process count
 *   - PID-namespace-wide termination
 *   - default-deny egress
 *   - protection against symlink and mount escape, and a minimal /proc and
 *     device exposure
 */
export const LINUX_BACKEND_ID = "linux-namespace-cgroup";

/**
 * What a macOS implementation must provide:
 *
 *   - a supported sandbox, container, or virtualization mechanism
 *     (`sandbox-exec` is deprecated and is not a supportable foundation)
 *   - filesystem grant enforcement and process-tree control
 *   - network restriction and an isolated temporary and profile location
 */
export const MACOS_BACKEND_ID = "macos-sandbox";

function unavailableDescriptor(
  backendId: string,
  kind: BackendKind,
  platform: NodeJS.Platform,
): BackendDescriptor {
  return parseBackendDescriptor({
    schemaVersion: BACKEND_DESCRIPTOR_SCHEMA_VERSION,
    backendId,
    kind,
    platform,
    securityClass: "unavailable",
    capabilities: {
      filesystemIsolation: false,
      processTreeControl: false,
      networkBoundary: "unsupported",
      identityIsolation: false,
      profileIsolation: false,
      quotas: noQuotaSupport(),
    },
    versionEvidence: null,
  });
}

function refuse(backendId: string, availability: BackendAvailability): never {
  throw new ProcessBrokerError(
    "BACKEND_UNAVAILABLE",
    "This platform sandbox backend is not available on this machine.",
    { backendId, reason: availability.reason, detail: availability.detail },
  );
}

interface ProbeOnly {
  readonly backendId: string;
  readonly kind: BackendKind;
  readonly platform: NodeJS.Platform;
  readonly validationDetail?: string;
  probe(): Promise<BackendAvailability>;
}

/**
 * Builds a backend that can be probed and described but never spawns. Every
 * side-effecting method refuses with the probe's own reason code.
 */
function probeOnlyBackend(spec: ProbeOnly): SandboxBackend {
  const descriptor = unavailableDescriptor(spec.backendId, spec.kind, spec.platform);
  let cached: BackendAvailability | null = null;

  const availability = async (): Promise<BackendAvailability> => {
    cached ??= await spec.probe();
    return cached;
  };

  return Object.freeze({
    describe: (): BackendDescriptor => descriptor,
    probe: (): Promise<BackendAvailability> => availability(),
    validateGrant: (_grant: CapabilityGrant): BackendAvailability =>
      Object.freeze({
        available: false,
        reason: "not-implemented" as const,
        detail: spec.validationDetail ?? "enforcement-not-implemented",
      }),
    prepare: async (): Promise<SandboxSession> => refuse(spec.backendId, await availability()),
    spawn: async (): Promise<BackendProcess> => refuse(spec.backendId, await availability()),
    dispose: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  });
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandSucceeds(command: string, args: readonly string[]): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function createWindowsSandboxBackend(
  options: { readonly platform?: NodeJS.Platform } = {},
): SandboxBackend {
  const platform = options.platform ?? process.platform;
  return probeOnlyBackend({
    backendId: WINDOWS_BACKEND_ID,
    kind: "windows-job-object",
    platform,
    validationDetail:
      "windows-native-process-composition-and-corpus-unverified",
    async probe(): Promise<BackendAvailability> {
      if (platform !== "win32") {
        return Object.freeze({
          available: false,
          reason: "unsupported-platform" as const,
          detail: "requires-windows",
        });
      }
      // The observed host exposes the documented Win32/AppContainer/Job APIs
      // and the experimental processmodel exports, but export presence does
      // not prove a production composition. The experimental route has no
      // authoritative bundled FlatBuffer layout, while both documented routes
      // require a reviewed process-creation composition and actual native
      // corpus evidence. A separately authorized same-user proof confirmed
      // that one uniquely named AppContainer profile and task-owned ACL grant
      // could be created and removed without measured residue, but it launched
      // no workload and does not establish an enforcement boundary.
      return Object.freeze({
        available: false,
        reason: "not-implemented" as const,
        detail: "windows-native-process-composition-and-corpus-unverified",
      });
    },
  });
}

export function createLinuxSandboxBackend(
  options: { readonly platform?: NodeJS.Platform } = {},
): SandboxBackend {
  const platform = options.platform ?? process.platform;
  return probeOnlyBackend({
    backendId: LINUX_BACKEND_ID,
    kind: "linux-namespace",
    platform,
    async probe(): Promise<BackendAvailability> {
      if (platform !== "linux") {
        return Object.freeze({
          available: false,
          reason: "unsupported-platform" as const,
          detail: "requires-linux",
        });
      }
      const hasBubblewrap = await canExecute("/usr/bin/bwrap");
      const hasCgroupV2 = await canRead("/sys/fs/cgroup/cgroup.controllers");
      if (!hasBubblewrap) {
        return Object.freeze({
          available: false,
          reason: "missing-tooling" as const,
          detail: "bubblewrap-not-installed",
        });
      }
      if (!hasCgroupV2) {
        return Object.freeze({
          available: false,
          reason: "missing-privilege" as const,
          detail: "cgroup-v2-unavailable",
        });
      }
      return Object.freeze({
        available: false,
        reason: "not-implemented" as const,
        detail: "namespace-and-cgroup-enforcement-not-implemented",
      });
    },
  });
}

export function createMacosSandboxBackend(
  options: { readonly platform?: NodeJS.Platform } = {},
): SandboxBackend {
  const platform = options.platform ?? process.platform;
  return probeOnlyBackend({
    backendId: MACOS_BACKEND_ID,
    kind: "macos-sandbox",
    platform,
    async probe(): Promise<BackendAvailability> {
      if (platform !== "darwin") {
        return Object.freeze({
          available: false,
          reason: "unsupported-platform" as const,
          detail: "requires-macos",
        });
      }
      const hasSandboxExec = await commandSucceeds("/usr/bin/which", ["sandbox-exec"]);
      return Object.freeze({
        available: false,
        reason: hasSandboxExec ? ("not-implemented" as const) : ("missing-tooling" as const),
        detail: hasSandboxExec
          ? "sandbox-exec-is-deprecated-and-not-a-supported-foundation"
          : "no-supported-sandbox-primitive",
      });
    },
  });
}

/** The platform backend seam for the current host, whatever it is. */
export function createPlatformSandboxBackend(
  options: { readonly platform?: NodeJS.Platform } = {},
): SandboxBackend {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return createWindowsSandboxBackend({ platform });
  }
  if (platform === "linux") {
    return createLinuxSandboxBackend({ platform });
  }
  return createMacosSandboxBackend({ platform });
}
