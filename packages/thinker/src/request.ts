import {
  parseApplicationConfiguration,
  type ApplicationConfiguration
} from "@ai-dev-os/config";
import { validation } from "@ai-dev-os/domain";
import {
  parsePromptCompilationRequest,
  type PromptCompilationRequest
} from "@ai-dev-os/prompt-compiler";
import { THINKER_SCHEMA_VERSION } from "./configuration.js";

const {
  ensureExactKeys,
  ensureNullable,
  ensureRecord,
  ensureSchemaVersion,
  ensureString,
  fail
} = validation;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ALIAS_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export interface ThinkerRequest {
  readonly schemaVersion: typeof THINKER_SCHEMA_VERSION;
  readonly requestId: string;
  readonly configuration: ApplicationConfiguration;
  readonly selectedAlias: string | null;
  readonly compilation: PromptCompilationRequest;
}

export function parseThinkerRequest(value: unknown, path = "thinkerRequest"): ThinkerRequest {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    ["schemaVersion", "requestId", "configuration", "selectedAlias", "compilation"],
    path
  );
  ensureSchemaVersion(record["schemaVersion"], `${path}.schemaVersion`, THINKER_SCHEMA_VERSION);
  const requestId = ensureString(record["requestId"], `${path}.requestId`, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
    patternName: "stable identifier"
  });
  const compilation = parsePromptCompilationRequest(record["compilation"], `${path}.compilation`);
  if (requestId !== compilation.requestId) {
    fail(`${path}.requestId`, "request_binding_mismatch", "must match the compilation request ID.");
  }
  return Object.freeze({
    schemaVersion: THINKER_SCHEMA_VERSION,
    requestId,
    configuration: parseApplicationConfiguration(record["configuration"], `${path}.configuration`),
    selectedAlias: ensureNullable(record["selectedAlias"], (raw) =>
      ensureString(raw, `${path}.selectedAlias`, {
        minLength: 1,
        maxLength: 64,
        pattern: ALIAS_PATTERN,
        patternName: "model alias"
      })
    ),
    compilation
  });
}
