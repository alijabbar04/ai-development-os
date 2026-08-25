import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const STAGE_18E_I_MANIFEST_PATH = "docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json";
export const STAGE_18E_I_MANIFEST_ALGORITHM = "ai-dev-os.stage-18e-i.sanitized-success-receipt.git-blob-subject.v1";
export const STAGE_18E_I_BASE_COMMIT = "b438ed13b7213640e6a637d173bfefcf697ca9b8";
export const STAGE_18E_I_PUBLISHED_COMMIT = "f90a779fce8c14cb6c4c3166ed89b0af5355b660";
export const STAGE_18E_I_PUBLISHED_TREE = "f4a0035c03150970f700435af64cd2bd4e0968e4";
export const STAGE_18E_I_PUBLISHED_MANIFEST_SHA256 = "f296c931bd9fa924126c9ff39a518f1a3d438b28ba76dd33580e0743c8a1b57d";
const HASH = /^[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40,64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(code, detail = "") {
  throw new Error(`${code}${detail.length === 0 ? "" : `:${detail}`}`);
}

export function runGit(repositoryRoot, arguments_, options = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: options.binary === true ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail("SUBJECT_GIT_FAILED", arguments_.join(" "));
  }
  return result.stdout;
}

export function resolveCommit(repositoryRoot, revision) {
  const commit = String(runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
  if (!COMMIT.test(commit)) fail("SUBJECT_COMMIT_REFUSED", commit);
  return commit;
}

export function assertStage18eIBaseCommit(value) {
  if (value !== STAGE_18E_I_BASE_COMMIT) fail("SUBJECT_MANIFEST_BASE_REFUSED");
  return STAGE_18E_I_BASE_COMMIT;
}

export function assertStage18eIManifestBase(manifest) {
  const descriptor = typeof manifest === "object" && manifest !== null
    ? Object.getOwnPropertyDescriptor(manifest, "baseCommit")
    : undefined;
  if (descriptor === undefined || !("value" in descriptor)) fail("SUBJECT_MANIFEST_BASE_REFUSED");
  return assertStage18eIBaseCommit(descriptor.value);
}

function subjectPath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) || value.includes("\\") || /[\u0000\r\n\t]/u.test(value) ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) fail("SUBJECT_PATH_REFUSED", String(value));
  return value;
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function parseNameStatusZ(bytes) {
  let decoded;
  try { decoded = typeof bytes === "string" ? bytes : UTF8.decode(bytes); }
  catch { fail("SUBJECT_PATH_UTF8_REFUSED"); }
  if (decoded.length === 0) return Object.freeze([]);
  const fields = decoded.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) fail("SUBJECT_DIFF_FORMAT_REFUSED");
  const seen = new Set();
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = subjectPath(fields[index + 1]);
    if (!/^[AMDTUXB]$/u.test(status)) fail("SUBJECT_DIFF_STATUS_REFUSED", status);
    if (seen.has(path)) fail("SUBJECT_DIFF_DUPLICATE_PATH", path);
    seen.add(path);
    entries.push(Object.freeze({ status, path }));
  }
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return Object.freeze(entries);
}

function aggregate(files) {
  const digest = createHash("sha256");
  let prior = null;
  for (const file of files) {
    subjectPath(file.path);
    if (
      !HASH.test(file.sha256) || !OID.test(file.blobOid) ||
      !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 ||
      (prior !== null && comparePaths(prior, file.path) >= 0)
    ) fail("SUBJECT_FILE_RECORD_REFUSED", file.path);
    digest.update(`${file.sha256}\t${file.byteCount}\t${file.blobOid}\t${file.path}\n`, "utf8");
    prior = file.path;
  }
  return digest.digest("hex");
}

export function serializeSubjectManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function collectSubjectManifest(repositoryRoot, baseRevision, sourceRevision) {
  const baseCommit = resolveCommit(repositoryRoot, baseRevision);
  const sourceCommit = resolveCommit(repositoryRoot, sourceRevision);
  const sourceTree = String(runGit(repositoryRoot, ["rev-parse", "--verify", `${sourceCommit}^{tree}`])).trim();
  if (!OID.test(sourceTree)) fail("SUBJECT_TREE_REFUSED", sourceTree);
  runGit(repositoryRoot, ["merge-base", "--is-ancestor", baseCommit, sourceCommit]);
  const entries = parseNameStatusZ(runGit(repositoryRoot, [
    "diff", "--name-status", "-z", "--no-renames", baseCommit, sourceCommit,
  ], { binary: true }));
  if (entries.some((entry) => entry.path === STAGE_18E_I_MANIFEST_PATH)) {
    fail("SUBJECT_MANIFEST_SELF_REFERENCE");
  }
  const files = [];
  const deletedPaths = [];
  let totalBlobBytes = 0;
  for (const entry of entries) {
    if (entry.status === "D") {
      deletedPaths.push(entry.path);
      continue;
    }
    const blob = runGit(repositoryRoot, ["cat-file", "blob", `${sourceCommit}:${entry.path}`], { binary: true });
    const blobOid = String(runGit(repositoryRoot, ["rev-parse", "--verify", `${sourceCommit}:${entry.path}`])).trim();
    if (!OID.test(blobOid)) fail("SUBJECT_BLOB_OID_REFUSED", entry.path);
    totalBlobBytes += blob.byteLength;
    files.push(Object.freeze({
      path: entry.path,
      changeType: entry.status,
      byteCount: blob.byteLength,
      blobOid,
      sha256: createHash("sha256").update(blob).digest("hex"),
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    algorithm: STAGE_18E_I_MANIFEST_ALGORITHM,
    baseCommit,
    sourceCommit,
    sourceTree,
    manifestPath: STAGE_18E_I_MANIFEST_PATH,
    rules: {
      subject: "all non-deleted Git blobs changed by baseCommit..sourceCommit with rename detection disabled; deletions are recorded separately",
      pathOrder: "ascending raw UTF-8 byte order; CR, LF, TAB, NUL, backslash, absolute, dot, and empty path segments refused",
      blobBytes: "exact committed Git blob bytes at sourceCommit; working-tree and filesystem bytes are not inputs",
      rowFormat: "<sha256>\\t<byteCount>\\t<blobOid>\\t<path>\\n encoded as UTF-8 with LF",
      manifestCommit: "the verifier requires a one-parent HEAD whose only parent-to-HEAD change is addition of manifestPath and whose parent equals sourceCommit",
    },
    inventory: {
      changedPathCount: entries.length,
      blobPathCount: files.length,
      deletedPathCount: deletedPaths.length,
      totalBlobBytes,
      deletedPaths,
    },
    excludedPaths: [{
      path: STAGE_18E_I_MANIFEST_PATH,
      reason: "not present in sourceCommit; added only by its manifest-only child commit to avoid self-reference",
    }],
    aggregateSha256: aggregate(files),
    files,
    generator: { identity: "scripts/generate-stage-18e-i-subject-manifest.mjs", version: 1 },
    verifier: {
      identity: "scripts/verify-stage-18e-i-subject-manifest.mjs",
      command: "npm run verify:stage-18e-i-subject-manifest",
      writesRepository: false,
    },
  });
}

function firstDifference(actual, expected, path = "manifest") {
  if (Object.is(actual, expected)) return null;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return path;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(actual[index], expected[index], `${path}[${index}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return `${path}.keys`;
    for (const key of expectedKeys) {
      const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
      if (difference !== null) return difference;
    }
    return null;
  }
  return path;
}

export function assertManifestEquivalent(actual, expected) {
  const difference = firstDifference(actual, expected);
  if (difference !== null) fail("SUBJECT_MANIFEST_DRIFT", difference);
}

export function readCommittedSubjectManifest(repositoryRoot, revision) {
  const commit = resolveCommit(repositoryRoot, revision);
  const bytes = runGit(repositoryRoot, ["cat-file", "blob", `${commit}:${STAGE_18E_I_MANIFEST_PATH}`], { binary: true });
  if (bytes.byteLength > 2_000_000) fail("SUBJECT_MANIFEST_TOO_LARGE");
  let raw;
  try { raw = UTF8.decode(bytes); }
  catch { fail("SUBJECT_MANIFEST_UTF8_REFUSED"); }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { fail("SUBJECT_MANIFEST_JSON_REFUSED"); }
  return Object.freeze({ raw, manifest });
}

export function isStage18eIPublishedLineage(repositoryRoot, revision = "HEAD") {
  const head = resolveCommit(repositoryRoot, revision);
  const result = spawnSync("git", [
    "merge-base", "--is-ancestor", STAGE_18E_I_PUBLISHED_COMMIT, head,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    fail("SUBJECT_GIT_FAILED", "merge-base --is-ancestor published HEAD");
  }
  return result.status === 0;
}

export function hasCommittedStage18eIManifest(repositoryRoot, revision = "HEAD") {
  const head = resolveCommit(repositoryRoot, revision);
  const bytes = runGit(repositoryRoot, [
    "ls-tree", "-z", "--full-tree", head, "--", STAGE_18E_I_MANIFEST_PATH,
  ], { binary: true });
  if (bytes.byteLength === 0) return false;
  let decoded;
  try { decoded = UTF8.decode(bytes); }
  catch { fail("SUBJECT_TREE_ENTRY_UTF8_REFUSED"); }
  const records = decoded.split("\0");
  if (records.length !== 2 || records[1] !== "") fail("SUBJECT_TREE_ENTRY_REFUSED");
  const separator = records[0].indexOf("\t");
  if (separator < 0 || records[0].slice(separator + 1) !== STAGE_18E_I_MANIFEST_PATH) {
    fail("SUBJECT_TREE_ENTRY_REFUSED");
  }
  const metadata = records[0].slice(0, separator).split(" ");
  if (metadata.length !== 3 || metadata[1] !== "blob" || !OID.test(metadata[2])) {
    fail("SUBJECT_TREE_ENTRY_REFUSED");
  }
  return true;
}

export function verifyStage18eIPublishedAnchor(repositoryRoot) {
  const head = resolveCommit(repositoryRoot, STAGE_18E_I_PUBLISHED_COMMIT);
  if (head !== STAGE_18E_I_PUBLISHED_COMMIT) fail("SUBJECT_PUBLISHED_COMMIT_DRIFT");
  const tree = String(runGit(repositoryRoot, ["rev-parse", "--verify", `${head}^{tree}`])).trim();
  if (tree !== STAGE_18E_I_PUBLISHED_TREE) fail("SUBJECT_PUBLISHED_TREE_DRIFT");
  const { raw, manifest } = readCommittedSubjectManifest(repositoryRoot, head);
  if (
    typeof manifest !== "object" || manifest === null ||
    typeof manifest.baseCommit !== "string" || typeof manifest.sourceCommit !== "string"
  ) fail("SUBJECT_MANIFEST_SHAPE_REFUSED");
  assertStage18eIManifestBase(manifest);
  const parents = String(runGit(repositoryRoot, ["rev-list", "--parents", "-n", "1", head])).trim().split(/\s+/u);
  if (parents.length !== 2 || parents[1] !== manifest.sourceCommit) fail("SUBJECT_MANIFEST_PARENT_DRIFT");
  const changes = parseNameStatusZ(runGit(repositoryRoot, [
    "diff", "--name-status", "-z", "--no-renames", parents[1], head,
  ], { binary: true }));
  if (
    changes.length !== 1 || changes[0]?.status !== "A" ||
    changes[0]?.path !== STAGE_18E_I_MANIFEST_PATH
  ) fail("SUBJECT_MANIFEST_COMMIT_NOT_MANIFEST_ONLY");
  const expected = collectSubjectManifest(repositoryRoot, STAGE_18E_I_BASE_COMMIT, parents[1]);
  assertManifestEquivalent(manifest, expected);
  if (raw !== serializeSubjectManifest(expected)) fail("SUBJECT_MANIFEST_SERIALIZATION_DRIFT");
  const manifestSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  if (manifestSha256 !== STAGE_18E_I_PUBLISHED_MANIFEST_SHA256) {
    fail("SUBJECT_PUBLISHED_MANIFEST_DIGEST_DRIFT");
  }
  return Object.freeze({
    head,
    tree,
    raw,
    manifest: expected,
    manifestSha256,
    sourceCommit: expected.sourceCommit,
    sourceTree: expected.sourceTree,
    fileCount: expected.inventory.blobPathCount,
    aggregateSha256: expected.aggregateSha256,
  });
}

export function assertStage18eIPublishedAnchorPreserved(repositoryRoot, revision = "HEAD") {
  const published = verifyStage18eIPublishedAnchor(repositoryRoot);
  const head = resolveCommit(repositoryRoot, revision);
  if (!isStage18eIPublishedLineage(repositoryRoot, head)) fail("SUBJECT_PUBLISHED_ANCESTRY_REFUSED");
  if (!hasCommittedStage18eIManifest(repositoryRoot, head)) fail("SUBJECT_PUBLISHED_MANIFEST_MISSING");
  const publishedManifestOid = String(runGit(repositoryRoot, [
    "rev-parse", "--verify", `${published.head}:${STAGE_18E_I_MANIFEST_PATH}`,
  ])).trim();
  const currentManifestOid = String(runGit(repositoryRoot, [
    "rev-parse", "--verify", `${head}:${STAGE_18E_I_MANIFEST_PATH}`,
  ])).trim();
  if (currentManifestOid !== publishedManifestOid) fail("SUBJECT_PUBLISHED_MANIFEST_CHANGED");
  return Object.freeze({
    ...published,
    currentHead: head,
    status: head === published.head ? "exact-published-head" : "published-anchor-descendant",
  });
}
