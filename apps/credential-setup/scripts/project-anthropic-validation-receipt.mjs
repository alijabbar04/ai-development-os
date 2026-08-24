import { isAbsolute } from "node:path";

const VALUE_FLAGS = Object.freeze([
  "--root",
  "--receipt-id",
  "--candidate-head",
  "--candidate-tree",
  "--manifest-aggregate",
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  if (argv.length !== VALUE_FLAGS.length * 2) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!VALUE_FLAGS.includes(flag) || values.has(flag) || typeof value !== "string" || value.length === 0) return null;
    values.set(flag, value);
  }
  return Object.freeze({
    root: values.get("--root"),
    receiptId: values.get("--receipt-id"),
    candidateHead: values.get("--candidate-head"),
    candidateTree: values.get("--candidate-tree"),
    candidateManifestAggregate: values.get("--manifest-aggregate"),
  });
}

const input = parseArguments(process.argv.slice(2));
if (
  input === null || !isAbsolute(input.root) ||
  !/^[a-f0-9]{64}$/u.test(input.receiptId) ||
  !/^[a-f0-9]{40}$/u.test(input.candidateHead) ||
  !/^[a-f0-9]{40}$/u.test(input.candidateTree) ||
  !/^[a-f0-9]{64}$/u.test(input.candidateManifestAggregate)
) {
  fail("RECEIPT_PROJECTION_ARGUMENTS_INVALID");
} else {
  try {
    const {
      createFileAnthropicValidationSuccessReceiptStore,
    } = await import("../dist/main/anthropic-validation-receipt-store.js");
    const store = createFileAnthropicValidationSuccessReceiptStore({ root: input.root });
    const projection = await store.readCommitted(input.receiptId, {
      candidateHead: input.candidateHead,
      candidateTree: input.candidateTree,
      candidateManifestAggregate: input.candidateManifestAggregate,
    });
    process.stdout.write(projection.canonicalDocument);
    process.stderr.write(`receipt-sha256=${projection.reference.receiptSha256}\n`);
  } catch (error) {
    let code = "RECEIPT_PROJECTION_FAILED";
    try {
      const descriptor = typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") code = descriptor.value;
    } catch { /* finite projection failure */ }
    fail(code);
  }
}
