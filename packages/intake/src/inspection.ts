import { posix, win32 } from "node:path";
import {
  INTAKE_GIT_QUERIES,
  INTAKE_LIMITS,
  type IntakeFileObservation,
  type IntakeGitPort,
  type IntakeGitResult,
  type IntakeMonotonicClock,
  type IntakePathFlavor,
  type IntakeFilesystemPort,
  type RepositoryInspectionReport,
  type RepositoryInspectionRequest,
} from "./contracts.js";
import { IntakeError, refuseIntake } from "./errors.js";
import {
  exactIntakeKeys,
  intakeArray,
  intakeRecord,
  validateIntakeText,
  validateSafeInteger,
} from "./text.js";

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

function canonicalRoot(value: unknown, flavor: IntakePathFlavor): string {
  const root = validateIntakeText(value, "root", {
    maximum: 32_767,
    allowNewlines: false,
  });
  if (flavor === "windows") {
    if (!/^[A-Z]:\\/u.test(root) || root.startsWith("\\\\") || win32.normalize(root) !== root) {
      refuseIntake("intake.root.invalid", "root");
    }
    const segments = root.slice(3).split("\\");
    if (
      segments.length === 0
      || segments.some((segment) => segment === "" || segment === "." || segment === ".."
        || /[<>:"/\\|?*\u0000-\u001F]/u.test(segment) || /[ .]$/u.test(segment)
        || WINDOWS_RESERVED.test(segment))
    ) {
      refuseIntake("intake.root.invalid", "root");
    }
    return root;
  }
  if (!root.startsWith("/") || root === "/" || posix.normalize(root) !== root) {
    refuseIntake("intake.root.invalid", "root");
  }
  const segments = root.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuseIntake("intake.root.invalid", "root");
  }
  return root;
}

function relativeTarget(value: unknown, flavor: IntakePathFlavor): string {
  const target = validateIntakeText(value, "file", { maximum: 4_096, allowNewlines: false });
  const api = flavor === "windows" ? win32 : posix;
  const separator = flavor === "windows" ? "\\" : "/";
  if (api.isAbsolute(target) || target.includes(flavor === "windows" ? "/" : "\\") || api.normalize(target) !== target) {
    refuseIntake("intake.root.not-contained", "file");
  }
  const segments = target.split(separator);
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || flavor === "windows" && segments.some((segment) => WINDOWS_RESERVED.test(segment)
      || /[<>:"|?*\u0000-\u001F]/u.test(segment) || /[ .]$/u.test(segment))
  ) {
    refuseIntake("intake.root.not-contained", "file");
  }
  return target;
}

function targetKey(value: string, flavor: IntakePathFlavor): string {
  return flavor === "windows" ? value.toLowerCase() : value;
}

function contained(root: string, candidate: string, flavor: IntakePathFlavor): boolean {
  const api = flavor === "windows" ? win32 : posix;
  const relative = api.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function sameCanonicalTarget(
  root: string,
  relativePath: string,
  candidate: string,
  flavor: IntakePathFlavor,
): boolean {
  const api = flavor === "windows" ? win32 : posix;
  const expected = api.join(root, relativePath);
  return flavor === "windows"
    ? expected.toLowerCase() === candidate.toLowerCase()
    : expected === candidate;
}

function rootLeaf(root: string, flavor: IntakePathFlavor): string {
  return (flavor === "windows" ? win32 : posix).basename(root);
}

function classifyFileFacts(files: readonly IntakeFileObservation[]): RepositoryInspectionReport["facts"] {
  const present = new Set(files.filter((file) => file.kind === "file").map((file) => file.relativePath.toLowerCase()));
  const facts: Array<RepositoryInspectionReport["facts"][number]> = [];
  if (present.has("package.json")) facts.push(Object.freeze({ kind: "ecosystem", value: "Node" }));
  if (present.has("pyproject.toml")) facts.push(Object.freeze({ kind: "ecosystem", value: "Python" }));
  if (present.has("cargo.toml")) facts.push(Object.freeze({ kind: "ecosystem", value: "Rust" }));
  if (present.has("go.mod")) facts.push(Object.freeze({ kind: "ecosystem", value: "Go" }));
  if ([...present].some((path) => path.endsWith(".sln"))) facts.push(Object.freeze({ kind: "ecosystem", value: ".NET" }));
  if (present.has("package-lock.json")) facts.push(Object.freeze({ kind: "package-manager", value: "npm" }));
  else if (present.has("pnpm-lock.yaml")) facts.push(Object.freeze({ kind: "package-manager", value: "pnpm" }));
  else if (present.has("yarn.lock")) facts.push(Object.freeze({ kind: "package-manager", value: "Yarn" }));
  return Object.freeze(facts);
}

function validateGitResult(result: IntakeGitResult, expected: IntakeGitResult["kind"]): IntakeGitResult {
  const input = intakeRecord(result, "git");
  exactIntakeKeys(input, ["kind", "status", "value", "failureCode"], "git");
  const kind = input["kind"];
  const status = input["status"];
  const value = input["value"];
  const failureCode = input["failureCode"];
  if (kind !== expected || (status !== "ok" && status !== "unavailable")) {
    refuseIntake("intake.git.refused", "git");
  }
  if (status === "ok" && (typeof value !== "string" || failureCode !== null)) {
    refuseIntake("intake.git.refused", "git");
  }
  if (
    status === "unavailable"
    && (value !== null || !["not-repository", "unborn-head", "detached", "deadline", "io"].includes(failureCode as string))
  ) {
    refuseIntake("intake.git.refused", "git");
  }
  return Object.freeze({
    kind: kind as IntakeGitResult["kind"],
    status,
    value: value as string | null,
    failureCode: failureCode as IntakeGitResult["failureCode"],
  });
}

function gitFact(
  result: IntakeGitResult,
  root: string,
  flavor: IntakePathFlavor,
): RepositoryInspectionReport["facts"][number] | null {
  if (result.status !== "ok" || result.value === null) return null;
  const value = result.value.trim();
  switch (result.kind) {
    case "root": {
      const observed = canonicalRoot(value, flavor);
      const api = flavor === "windows" ? win32 : posix;
      if (api.normalize(observed) !== api.normalize(root)) refuseIntake("intake.root.not-contained", "git");
      return null;
    }
    case "head":
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) refuseIntake("intake.git.refused", "git");
      return Object.freeze({ kind: "git-head", value });
    case "branch":
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/u.test(value)
        || value.includes("..") || value.includes("@{")
        || value.split("/").some((component) => component.length === 0
          || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))) {
        refuseIntake("intake.git.refused", "git");
      }
      return Object.freeze({ kind: "git-branch", value });
    case "status":
      return Object.freeze({ kind: "git-status", value: value === "" ? "clean" : "changed" });
    default:
      return null;
  }
}

export async function collectRepositoryInspection(
  request: RepositoryInspectionRequest,
  ports: Readonly<{
    filesystem: IntakeFilesystemPort;
    git: IntakeGitPort;
    clock: IntakeMonotonicClock;
  }>,
): Promise<RepositoryInspectionReport> {
  const input = intakeRecord(request, "inspection");
  exactIntakeKeys(input, [
    "approvedRoot", "pathFlavor", "relativePaths", "maximumFiles", "maximumBytes", "deadlineMs", "includeGit",
  ], "inspection");
  const pathFlavor = input["pathFlavor"];
  if (pathFlavor !== "windows" && pathFlavor !== "posix") {
    refuseIntake("intake.root.invalid", "root");
  }
  const root = canonicalRoot(input["approvedRoot"], pathFlavor);
  const maximumFiles = validateSafeInteger(input["maximumFiles"], "inspection", 1, INTAKE_LIMITS.inspectionFiles);
  const maximumBytes = validateSafeInteger(input["maximumBytes"], "inspection", 1, INTAKE_LIMITS.inspectionBytes);
  const deadlineMs = validateSafeInteger(input["deadlineMs"], "inspection", 1, INTAKE_LIMITS.inspectionDeadlineMs);
  if (typeof input["includeGit"] !== "boolean") {
    refuseIntake("intake.input.invalid", "inspection");
  }
  const targets = intakeArray(
    input["relativePaths"],
    "file",
    (target) => relativeTarget(target, pathFlavor),
    INTAKE_LIMITS.collection,
  );
  if (targets.length > maximumFiles) {
    refuseIntake("intake.inspection.limit", "inspection", { limit: maximumFiles });
  }
  if (new Set(targets.map((target) => targetKey(target, pathFlavor))).size !== targets.length) {
    refuseIntake("intake.input.invalid", "file");
  }
  const now = (): number => {
    try {
      const value = ports.clock.nowMs();
      if (!Number.isFinite(value) || value < 0) refuseIntake("intake.input.invalid", "inspection");
      return value;
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      return refuseIntake("intake.input.invalid", "inspection");
    }
  };
  const startedAt = now();
  const deadlineAtMs = startedAt + deadlineMs;
  if (!Number.isFinite(deadlineAtMs)) refuseIntake("intake.input.invalid", "inspection");

  let observed: readonly IntakeFileObservation[];
  try {
    observed = await ports.filesystem.inspect({
      approvedRoot: root,
      relativePaths: targets,
      deadlineAtMs,
      maximumBytes,
    });
  } catch {
    return Object.freeze({
      state: "unavailable",
      canonicalRoot: root,
      rootLeaf: rootLeaf(root, pathFlavor),
      files: Object.freeze([]),
      facts: Object.freeze([]),
      unavailable: Object.freeze([Object.freeze({ source: "filesystem", code: "io" })]),
      totalBytes: 0,
    });
  }
  if (now() > deadlineAtMs) {
    return Object.freeze({
      state: "unavailable",
      canonicalRoot: root,
      rootLeaf: rootLeaf(root, pathFlavor),
      files: Object.freeze([]),
      facts: Object.freeze([]),
      unavailable: Object.freeze([Object.freeze({ source: "filesystem", code: "deadline" })]),
      totalBytes: 0,
    });
  }
  const observedValues = intakeArray(observed, "file", (item) => item, INTAKE_LIMITS.collection);
  if (observedValues.length > targets.length || observedValues.length > maximumFiles) {
    refuseIntake("intake.inspection.limit", "inspection", { limit: maximumFiles });
  }
  const byTarget = new Map<string, IntakeFileObservation>();
  let totalBytes = 0;
  for (const itemValue of observedValues) {
    const item = intakeRecord(itemValue, "file");
    for (const required of ["relativePath", "canonicalPath", "kind", "byteLength", "reparsePoint", "failureCode"] as const) {
      if (!Object.hasOwn(item, required)) refuseIntake("intake.input.invalid", "file");
    }
    const relativePath = relativeTarget(item["relativePath"], pathFlavor);
    const key = targetKey(relativePath, pathFlavor);
    if (!targets.some((target) => targetKey(target, pathFlavor) === key) || byTarget.has(key)) {
      refuseIntake("intake.input.invalid", "file");
    }
    const kind = item["kind"];
    if (kind !== "file" && kind !== "directory" && kind !== "missing" && kind !== "unavailable") {
      refuseIntake("intake.input.invalid", "file");
    }
    const bytes = validateSafeInteger(item["byteLength"], "file", 0, maximumBytes);
    totalBytes += bytes;
    if (totalBytes > maximumBytes) refuseIntake("intake.inspection.limit", "inspection", { limit: maximumBytes });
    if (typeof item["reparsePoint"] !== "boolean") refuseIntake("intake.input.invalid", "file");
    if (item["reparsePoint"]) refuseIntake("intake.root.reparse", "file");
    const failureCode = item["failureCode"];
    if (failureCode !== null && !["access-denied", "not-found", "deadline", "io"].includes(failureCode as string)) {
      refuseIntake("intake.input.invalid", "file");
    }
    if ((kind === "file" || kind === "directory") && failureCode !== null) {
      refuseIntake("intake.input.invalid", "file");
    }
    if ((kind === "missing" || kind === "unavailable") && (bytes !== 0 || failureCode === null)) {
      refuseIntake("intake.input.invalid", "file");
    }
    let canonicalPath: string | null = null;
    if (item["canonicalPath"] !== null) {
      canonicalPath = canonicalRoot(item["canonicalPath"], pathFlavor);
      if (
        !contained(root, canonicalPath, pathFlavor)
        || !sameCanonicalTarget(root, relativePath, canonicalPath, pathFlavor)
      ) {
        refuseIntake("intake.root.not-contained", "file");
      }
    } else if (kind === "file" || kind === "directory") {
      refuseIntake("intake.input.invalid", "file");
    }
    if ((kind === "missing" || kind === "unavailable") && canonicalPath !== null) {
      refuseIntake("intake.input.invalid", "file");
    }
    byTarget.set(key, Object.freeze({
      relativePath,
      canonicalPath,
      kind,
      byteLength: bytes,
      reparsePoint: false,
      failureCode: failureCode as IntakeFileObservation["failureCode"],
    }));
  }
  const normalized = Object.freeze([...byTarget.values()].sort((left, right) => left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath ? 1 : 0));
  const files = Object.freeze(normalized.map((item) => Object.freeze({
    relativePath: item.relativePath,
    kind: item.kind,
    byteLength: item.byteLength,
  })));
  const facts: Array<RepositoryInspectionReport["facts"][number]> = [...classifyFileFacts(normalized)];
  const unavailable: Array<RepositoryInspectionReport["unavailable"][number]> = normalized
    .filter((item) => item.kind === "missing" || item.kind === "unavailable")
    .map((item) => Object.freeze({ source: "filesystem" as const, code: item.failureCode ?? item.kind }));
  if (observedValues.length < targets.length) unavailable.push(Object.freeze({ source: "filesystem", code: "incomplete" }));

  if (input["includeGit"]) {
    const policy = Object.freeze({
      readOnly: true as const,
      hooks: false as const,
      network: false as const,
      credentialHelpers: false as const,
      shell: false as const,
    });
    for (const query of INTAKE_GIT_QUERIES) {
      if (now() > deadlineAtMs) {
        unavailable.push(Object.freeze({ source: "git", code: "deadline" }));
        break;
      }
      try {
        const rawResult = await ports.git.run({
          root,
          args: query.args,
          deadlineAtMs,
          policy,
        });
        if (now() > deadlineAtMs) {
          unavailable.push(Object.freeze({ source: "git", code: "deadline" }));
          break;
        }
        const result = validateGitResult(rawResult, query.kind);
        const fact = gitFact(result, root, pathFlavor);
        if (fact !== null) facts.push(fact);
        if (result.status === "unavailable") unavailable.push(Object.freeze({
          source: "git",
          code: result.failureCode ?? "io",
        }));
      } catch (error) {
        if (error instanceof IntakeError) throw error;
        unavailable.push(Object.freeze({ source: "git", code: "io" }));
      }
    }
  }
  const state = unavailable.length === 0 ? "complete"
    : !normalized.some((item) => item.kind === "file" || item.kind === "directory") && facts.length === 0 ? "unavailable"
      : "partial";
  return Object.freeze({
    state,
    canonicalRoot: root,
    rootLeaf: rootLeaf(root, pathFlavor),
    files,
    facts: Object.freeze(facts),
    unavailable: Object.freeze(unavailable),
    totalBytes,
  });
}
