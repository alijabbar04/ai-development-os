"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const READER_ID = "ai-account-manager.usage-reader";
const READER_PROTOCOL_VERSION = 1;
const RUNTIME_VERSION = "1.4.1";
const REPOSITORY_URL =
  "https://github.com/alijabbar04/ai-account-manager.git";
const MAX_INPUT_NODES = 4096;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES = 256;
const MAX_LIMITS = 64;
const MAX_ALLOWLIST = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: "The usage-reader request is invalid.",
  SOURCE_UNAVAILABLE: "The Account Manager usage source is unavailable.",
  SOURCE_TOO_LARGE: "The Account Manager usage source exceeds its bound.",
  SOURCE_MALFORMED: "The Account Manager usage source is malformed.",
  PROFILE_NOT_ALLOWED: "The requested profile is not explicitly allowed.",
  PROFILE_NOT_FOUND: "The requested profile is not present in Account Manager.",
  SNAPSHOT_NOT_FOUND: "No usage snapshot exists for the requested profile.",
  SNAPSHOT_INVALID: "The requested usage snapshot is invalid.",
  SNAPSHOT_AMBIGUOUS: "The requested usage snapshot is ambiguous.",
});

class UsageReaderError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.SOURCE_UNAVAILABLE);
    this.name = "UsageReaderError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : "SOURCE_UNAVAILABLE";
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function fail(code) {
  throw new UsageReaderError(code);
}

function plainRecord(value, code = "SOURCE_MALFORMED") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code);
  }
  return value;
}

function exactKeys(value, allowed, code) {
  const record = plainRecord(value, code);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  for (const key of keys) {
    if (!allowed.includes(key)) fail(code);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set) fail(code);
  }
  return record;
}

function assertInputBudget(root) {
  const pending = [root];
  let nodes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) fail("INVALID_REQUEST");
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_INPUT_NODES) fail("INVALID_REQUEST");
      for (const item of value) pending.push(item);
      continue;
    }
    const record = plainRecord(value, "INVALID_REQUEST");
    const keys = Reflect.ownKeys(record);
    if (
      keys.length > MAX_INPUT_NODES ||
      keys.some((key) => typeof key !== "string")
    ) {
      fail("INVALID_REQUEST");
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set) {
        fail("INVALID_REQUEST");
      }
      pending.push(descriptor.value);
    }
  }
}

function finiteId(value, code = "INVALID_REQUEST") {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}

function finiteEnum(value, values, code) {
  if (!values.includes(value)) fail(code);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function parseJsonExactly(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("SOURCE_MALFORMED");
  }
  let offset = 0;
  let nodes = 0;
  let members = 0;
  const primitiveToken = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const whitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const stringToken = () => {
    if (text[offset] !== '"') fail("SOURCE_MALFORMED");
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset];
      offset += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          fail("SOURCE_MALFORMED");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail("SOURCE_MALFORMED");
      }
    }
    fail("SOURCE_MALFORMED");
  };
  const value = (depth) => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) fail("SOURCE_TOO_LARGE");
    if (depth > 64) fail("SOURCE_TOO_LARGE");
    whitespace();
    if (text[offset] === '"') {
      stringToken();
      return;
    }
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = stringToken();
        members += 1;
        if (members > MAX_INPUT_NODES) fail("SOURCE_TOO_LARGE");
        if (keys.has(key)) fail("SOURCE_MALFORMED");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") fail("SOURCE_MALFORMED");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("SOURCE_MALFORMED");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("SOURCE_MALFORMED");
        offset += 1;
      }
    }
    primitiveToken.lastIndex = offset;
    const token = primitiveToken.exec(text)?.[0];
    if (!token) fail("SOURCE_MALFORMED");
    offset += token.length;
  };
  value(0);
  whitespace();
  if (offset !== text.length) fail("SOURCE_MALFORMED");
  try {
    return Object.freeze({
      value: JSON.parse(text),
      fileDigest: crypto.createHash("sha256").update(buffer).digest("hex"),
    });
  } catch {
    fail("SOURCE_MALFORMED");
  }
}

function parseRequest(value) {
  try {
    assertInputBudget(value);
    const input = exactKeys(
      value,
      [
        "schemaVersion",
        "dataDirectory",
        "requestedProfileId",
        "profileAllowlist",
        "freshnessMs",
      ],
      "INVALID_REQUEST",
    );
    if (input.schemaVersion !== READER_PROTOCOL_VERSION) fail("INVALID_REQUEST");
    if (
      typeof input.dataDirectory !== "string" ||
      input.dataDirectory.length < 3 ||
      input.dataDirectory.length > 1024 ||
      !path.isAbsolute(input.dataDirectory) ||
      /^(?:\\\\|\/\/)/.test(input.dataDirectory) ||
      !(
        /^[A-Za-z]:[\\/]/.test(input.dataDirectory) ||
        input.dataDirectory.startsWith("/")
      )
    ) {
      fail("INVALID_REQUEST");
    }
    const requestedProfileId = finiteId(input.requestedProfileId);
    if (
      !Array.isArray(input.profileAllowlist) ||
      input.profileAllowlist.length < 1 ||
      input.profileAllowlist.length > MAX_ALLOWLIST
    ) {
      fail("INVALID_REQUEST");
    }
    const seen = new Set();
    const allowlist = input.profileAllowlist.map((item) => {
      const record = exactKeys(
        item,
        [
          "profileId",
          "providerId",
          "ownership",
          "authorization",
          "revocation",
        ],
        "INVALID_REQUEST",
      );
      const profileId = finiteId(record.profileId);
      if (seen.has(profileId)) fail("INVALID_REQUEST");
      seen.add(profileId);
      return Object.freeze({
        profileId,
        providerId: finiteEnum(record.providerId, ["claude-code"], "INVALID_REQUEST"),
        ownership: finiteEnum(
          record.ownership,
          ["owned", "authorized-borrowed"],
          "INVALID_REQUEST",
        ),
        authorization: finiteEnum(
          record.authorization,
          ["authorized", "unauthorized", "ambiguous"],
          "INVALID_REQUEST",
        ),
        revocation: finiteEnum(
          record.revocation,
          ["not-revoked", "revoked", "unknown"],
          "INVALID_REQUEST",
        ),
      });
    });
    if (
      !Number.isSafeInteger(input.freshnessMs) ||
      input.freshnessMs < 1000 ||
      input.freshnessMs > 15 * 60 * 1000
    ) {
      fail("INVALID_REQUEST");
    }
    const authority = allowlist.find(
      (entry) => entry.profileId === requestedProfileId,
    );
    if (!authority) fail("PROFILE_NOT_ALLOWED");
    return Object.freeze({
      dataDirectory: input.dataDirectory,
      requestedProfileId,
      allowlist: Object.freeze(allowlist),
      authority,
      freshnessMs: input.freshnessMs,
    });
  } catch (error) {
    if (error instanceof UsageReaderError) throw error;
    fail("INVALID_REQUEST");
  }
}

function readerConfigurationFingerprint(directory, request) {
  return digest({
    schemaVersion: READER_PROTOCOL_VERSION,
    dataDirectory: directory,
    profileAllowlist: request.allowlist,
    freshnessMs: request.freshnessMs,
  });
}

function canonicalDataDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("SOURCE_UNAVAILABLE");
    return fs.realpathSync.native(directory);
  } catch (error) {
    if (error instanceof UsageReaderError) throw error;
    fail("SOURCE_UNAVAILABLE");
  }
}

function readBoundedJson(directory, filename) {
  let descriptor;
  try {
    const target = path.join(directory, filename);
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) fail("SOURCE_UNAVAILABLE");
    if (before.size > MAX_FILE_BYTES) fail("SOURCE_TOO_LARGE");
    const realTarget = fs.realpathSync.native(target);
    if (path.dirname(realTarget).toLowerCase() !== directory.toLowerCase()) {
      fail("SOURCE_UNAVAILABLE");
    }
    descriptor = fs.openSync(realTarget, "r");
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(realTarget);
    if (
      !opened.isFile() ||
      opened.size > MAX_FILE_BYTES ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      fail(opened.size > MAX_FILE_BYTES ? "SOURCE_TOO_LARGE" : "SOURCE_UNAVAILABLE");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      offset !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      fail("SOURCE_UNAVAILABLE");
    }
    return parseJsonExactly(buffer.subarray(0, offset));
  } catch (error) {
    if (error instanceof UsageReaderError) throw error;
    if (error instanceof SyntaxError) fail("SOURCE_MALFORMED");
    fail("SOURCE_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is never returned or reused. Public errors remain finite.
      }
    }
  }
}

function parseProfiles(value, requestedProfileId) {
  const store = exactKeys(value, ["version", "profiles"], "SOURCE_MALFORMED");
  if (store.version !== 1 || !Array.isArray(store.profiles)) {
    fail("SOURCE_MALFORMED");
  }
  if (store.profiles.length > MAX_PROFILES) fail("SOURCE_TOO_LARGE");
  let matches = 0;
  for (const item of store.profiles) {
    const profile = plainRecord(item);
    if (profile.id === requestedProfileId) matches += 1;
  }
  if (matches === 0) fail("PROFILE_NOT_FOUND");
  if (matches !== 1) fail("SNAPSHOT_AMBIGUOUS");
}

function timestamp(value) {
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value > 1e12 ? value : value * 1000;
  } else if (typeof value === "string" && value.length <= 64) {
    milliseconds = Date.parse(value);
  }
  if (
    !Number.isFinite(milliseconds) ||
    Math.abs(milliseconds) > 8_640_000_000_000_000
  ) {
    fail("SNAPSHOT_INVALID");
  }
  let result;
  try {
    result = new Date(milliseconds).toISOString();
  } catch {
    fail("SNAPSHOT_INVALID");
  }
  if (Date.parse(result) !== milliseconds) fail("SNAPSHOT_INVALID");
  return result;
}

function basisPoints(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    fail("SNAPSHOT_INVALID");
  }
  const result = Math.round(value * 100);
  if (Math.abs(result / 100 - value) > 1e-9) fail("SNAPSHOT_INVALID");
  return result;
}

function parseLimit(value) {
  const limit = exactKeys(
    value,
    ["kind", "group", "percent", "severity", "resetsAt", "modelName", "isActive"],
    "SNAPSHOT_INVALID",
  );
  if (typeof limit.kind !== "string" || limit.kind.length > 64) {
    fail("SNAPSHOT_INVALID");
  }
  if (limit.isActive !== undefined && limit.isActive !== true) {
    fail("SNAPSHOT_INVALID");
  }
  return Object.freeze({
    kind: limit.kind,
    usedBasisPoints: basisPoints(limit.percent),
    resetAt: timestamp(limit.resetsAt),
  });
}

function parseSnapshot(value, request, nowMs) {
  const snapshots = plainRecord(value);
  const snapshotKeys = Reflect.ownKeys(snapshots);
  if (
    snapshotKeys.some((key) => typeof key !== "string") ||
    snapshotKeys.length > MAX_PROFILES
  ) {
    fail("SOURCE_TOO_LARGE");
  }
  if (!Object.hasOwn(snapshots, request.requestedProfileId)) {
    fail("SNAPSHOT_NOT_FOUND");
  }
  const raw = exactKeys(
    snapshots[request.requestedProfileId],
    ["fetchedAt", "ok", "error", "limits", "extra"],
    "SNAPSHOT_INVALID",
  );
  if (typeof raw.ok !== "boolean" || !Array.isArray(raw.limits)) {
    fail("SNAPSHOT_INVALID");
  }
  if (
    (raw.ok && raw.error !== undefined && raw.error !== null) ||
    (!raw.ok &&
      (typeof raw.error !== "string" ||
        raw.error.length < 1 ||
        raw.error.length > 256))
  ) {
    fail("SNAPSHOT_INVALID");
  }
  if (raw.limits.length > MAX_LIMITS) fail("SOURCE_TOO_LARGE");
  const observedAt = timestamp(raw.fetchedAt);
  const observedMs = Date.parse(observedAt);
  if (observedMs > nowMs + 1000) fail("SNAPSHOT_INVALID");
  const relevant = raw.limits
    .map(parseLimit)
    .filter((limit) => limit.kind === "session" || limit.kind === "weekly_all");
  const sessions = relevant.filter((limit) => limit.kind === "session");
  const weeklies = relevant.filter((limit) => limit.kind === "weekly_all");
  if (sessions.length !== 1 || weeklies.length !== 1) {
    fail(sessions.length > 1 || weeklies.length > 1 ? "SNAPSHOT_AMBIGUOUS" : "SNAPSHOT_INVALID");
  }
  const normalizeWindow = (limit, prefix) => {
    const resetMs = Date.parse(limit.resetAt);
    if (resetMs <= observedMs) fail("SNAPSHOT_INVALID");
    return Object.freeze({
      windowId: `${prefix}:${limit.resetAt}`,
      usedBasisPoints: limit.usedBasisPoints,
      remainingBasisPoints: 10_000 - limit.usedBasisPoints,
      resetAt: limit.resetAt,
    });
  };
  const freshUntilMs = Math.min(
    observedMs + request.freshnessMs,
    Date.parse(sessions[0].resetAt),
    Date.parse(weeklies[0].resetAt),
  );
  const observationBase = Object.freeze({
    sourceClass: raw.ok ? "provider-authoritative" : "provider-cached",
    confidence: raw.ok ? "high" : "low",
    timezone: "Europe/London",
    observedAt,
    freshUntil: new Date(freshUntilMs).toISOString(),
    fiveHour: normalizeWindow(sessions[0], "claude-code:five-hour"),
    weekly: normalizeWindow(weeklies[0], "claude-code:weekly"),
  });
  return Object.freeze({
    ...observationBase,
    observationId: `am-usage:${digest({
      requestedProfileId: request.requestedProfileId,
      ...observationBase,
    }).slice(0, 40)}`,
  });
}

function readScopedUsage(value, options = {}) {
  const request = parseRequest(value);
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("INVALID_REQUEST");
  const directory = canonicalDataDirectory(request.dataDirectory);
  const profiles = readBoundedJson(directory, "profiles.json");
  parseProfiles(profiles.value, request.requestedProfileId);
  const snapshots = readBoundedJson(directory, "usage-snapshots.json");
  const profilesAfterSnapshot = readBoundedJson(directory, "profiles.json");
  if (profiles.fileDigest !== profilesAfterSnapshot.fileDigest) {
    fail("SOURCE_UNAVAILABLE");
  }
  parseProfiles(profilesAfterSnapshot.value, request.requestedProfileId);
  const observation = parseSnapshot(snapshots.value, request, nowMs);
  const configurationFingerprint = readerConfigurationFingerprint(
    directory,
    request,
  );
  return Object.freeze({
    schemaVersion: READER_PROTOCOL_VERSION,
    reader: Object.freeze({
      readerId: READER_ID,
      protocolVersion: READER_PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      repositoryUrl: REPOSITORY_URL,
      configurationFingerprint,
    }),
    requestedProfileId: request.requestedProfileId,
    profile: Object.freeze({
      scopedProfileId: request.requestedProfileId,
      providerId: request.authority.providerId,
      ownership: request.authority.ownership,
      authorization: request.authority.authorization,
      revocation: request.authority.revocation,
      authorityEstimate: "caller-allowlist",
    }),
    observation,
  });
}

function finiteError(error) {
  return error instanceof UsageReaderError
    ? error
    : new UsageReaderError("SOURCE_UNAVAILABLE");
}

function assertReadBoundary(request, nowMs) {
  if (request === undefined) return;
  const input = exactKeys(request, ["signal", "deadline"], "INVALID_REQUEST");
  if (
    input.signal === null ||
    typeof input.signal !== "object" ||
    typeof input.signal.aborted !== "boolean" ||
    typeof input.deadline !== "string" ||
    input.deadline.length > 64
  ) {
    fail("INVALID_REQUEST");
  }
  const deadline = Date.parse(input.deadline);
  if (!Number.isFinite(deadline)) fail("INVALID_REQUEST");
  if (input.signal.aborted || nowMs >= deadline) fail("SOURCE_UNAVAILABLE");
}

function createScopedUsageReader(value, options = {}) {
  try {
    assertInputBudget(value);
    const input = exactKeys(
      value,
      ["schemaVersion", "dataDirectory", "profileAllowlist", "freshnessMs"],
      "INVALID_REQUEST",
    );
    if (
      !Array.isArray(input.profileAllowlist) ||
      input.profileAllowlist.length < 1 ||
      input.profileAllowlist.length > MAX_ALLOWLIST
    ) {
      fail("INVALID_REQUEST");
    }
    const validated = input.profileAllowlist.map((entry) => {
      const profile = plainRecord(entry, "INVALID_REQUEST");
      const parsed = parseRequest({
        schemaVersion: input.schemaVersion,
        dataDirectory: input.dataDirectory,
        requestedProfileId: profile.profileId,
        profileAllowlist: input.profileAllowlist,
        freshnessMs: input.freshnessMs,
      });
      return parsed.authority;
    });
    const profileAllowlist = Object.freeze(
      validated.map((entry) => Object.freeze({ ...entry })),
    );
    const dataDirectory = canonicalDataDirectory(input.dataDirectory);
    const configuration = Object.freeze({
      schemaVersion: READER_PROTOCOL_VERSION,
      dataDirectory,
      profileAllowlist,
      freshnessMs: input.freshnessMs,
    });
    const parsedConfiguration = parseRequest({
      ...configuration,
      requestedProfileId: profileAllowlist[0].profileId,
    });
    const configurationFingerprint = readerConfigurationFingerprint(
      dataDirectory,
      parsedConfiguration,
    );
    return Object.freeze({
      fixtureOnly: false,
      readerId: READER_ID,
      protocolVersion: READER_PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      repositoryUrl: REPOSITORY_URL,
      configurationFingerprint,
      async readScopedUsage(profileId, request) {
        const readNow = () =>
          typeof options.now === "function" ? options.now() : Date.now();
        assertReadBoundary(request, readNow());
        await new Promise((resolve) => setImmediate(resolve));
        assertReadBoundary(request, readNow());
        const result = readScopedUsage(
          { ...configuration, requestedProfileId: profileId },
          options,
        );
        assertReadBoundary(request, readNow());
        return result;
      },
    });
  } catch (error) {
    if (error instanceof UsageReaderError) throw error;
    fail("INVALID_REQUEST");
  }
}

module.exports = Object.freeze({
  READER_ID,
  READER_PROTOCOL_VERSION,
  RUNTIME_VERSION,
  REPOSITORY_URL,
  UsageReaderError,
  createScopedUsageReader,
  readScopedUsage,
  finiteError,
});
