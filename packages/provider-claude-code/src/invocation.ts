/**
 * Safe Claude Code invocation construction.
 *
 * The adapter owns the complete, finite argument vector. There is no caller
 * input path into the argument list: instructions travel on stdin, and every
 * other value is either a fixed literal or a token that has already been
 * validated against a pattern which cannot produce a leading `-`.
 *
 * Nothing here builds a command string, and nothing here can be handed to a
 * shell. The vector is passed to the process broker, which spawns an
 * executable plus an argument array and has no shell mode to enable.
 */

import { validation } from "@ai-dev-os/domain";
import type { CapabilityGrant } from "@ai-dev-os/process-broker";
import { grantAllowsOperation } from "@ai-dev-os/process-broker";
import type {
  CodingAgentRequest,
  CodingCapability,
  CommandPolicy,
  NetworkPolicy,
} from "@ai-dev-os/providers";
import { microsToBudgetArgument, type ClaudeAdapterConfiguration, type ClaudeEffortLevel } from "./config.js";
import type { ClaudeCliCapabilities } from "./compatibility.js";
import { isValidSessionId } from "./session.js";
import {
  invalidRequestError,
  unsupportedCapabilityError,
  type ClaudeDetailCode,
} from "./errors.js";

const { ensureString } = validation;

/**
 * The finite built-in tool surface. Claude's `--tools` flag takes names from
 * the built-in set; nothing outside this table is ever named, and the empty
 * string is used to mean "no tools at all".
 */
export const CLAUDE_TOOL_NAMES = Object.freeze({
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  notebookEdit: "NotebookEdit",
  bash: "Bash",
  todoWrite: "TodoWrite",
} as const);

/**
 * Tools that must never appear. Web access, browser control, background
 * execution, and sub-agent spawning are all outside what a reconciled,
 * contained coding attempt can account for.
 */
export const ALWAYS_DENIED_TOOLS: readonly string[] = Object.freeze([
  "WebSearch",
  "WebFetch",
  "Task",
  "Agent",
  "BashOutput",
  "KillShell",
  "SlashCommand",
  "AskUserQuestion",
  "SendUserMessage",
  "ListMcpResources",
  "ReadMcpResource",
]);

/** Every MCP tool is denied by a wildcard rule in addition to strict-mcp-config. */
export const MCP_DENY_RULE = "mcp__*";

export const CLAUDE_PERMISSION_MODE = "dontAsk";

export interface ClaudeToolPlan {
  /** Built-in tool names passed to `--tools`. Empty means no tools at all. */
  readonly tools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly bashPermitted: boolean;
  readonly writePermitted: boolean;
}

export type ToolPlanOutcome =
  | { readonly ok: true; readonly plan: ClaudeToolPlan }
  | { readonly ok: false; readonly detailCode: ClaudeDetailCode; readonly message: string };

function planFailure(detailCode: ClaudeDetailCode, message: string): ToolPlanOutcome {
  return Object.freeze({ ok: false, detailCode, message });
}

/**
 * Translates the provider-neutral capability, command, and network policy into
 * the narrowest Claude tool surface that can honour it.
 *
 * The translation is conservative in one direction only: when the neutral
 * semantics cannot be preserved exactly, the answer is a refusal rather than a
 * looser approximation.
 */
export function planTools(input: {
  readonly capabilities: readonly CodingCapability[];
  readonly commandPolicy: CommandPolicy;
  readonly networkPolicy: NetworkPolicy;
  readonly grant: CapabilityGrant;
  /**
   * Whether the composition layer has accepted that commands run under this
   * backend's actual containment. On the shipped development backend that
   * containment is none, so accepting it is a deliberate development choice
   * and every result carries the uncontained-execution warning.
   */
  readonly commandExecutionAllowed: boolean;
}): ToolPlanOutcome {
  const capabilities = new Set(input.capabilities);
  const tools: string[] = [];

  if (capabilities.has("read-files")) {
    tools.push(CLAUDE_TOOL_NAMES.read, CLAUDE_TOOL_NAMES.glob, CLAUDE_TOOL_NAMES.grep);
  }

  if (capabilities.has("edit-files")) {
    if (!grantAllowsOperation(input.grant, "workspace-write")) {
      return planFailure(
        "policy-denied",
        "The capability grant does not permit writing to the managed workspace.",
      );
    }
    tools.push(CLAUDE_TOOL_NAMES.edit, CLAUDE_TOOL_NAMES.write, CLAUDE_TOOL_NAMES.notebookEdit);
  }

  if (capabilities.has("git-commit") && !grantAllowsOperation(input.grant, "git-commit")) {
    return planFailure("policy-denied", "The capability grant does not permit creating a commit.");
  }

  let bashPermitted = false;
  switch (input.commandPolicy.mode) {
    case "none":
      // Bash is removed entirely rather than restricted by a textual rule.
      break;
    case "allow-listed":
      // The neutral contract names executables. A Claude Bash permission rule
      // is a textual command-prefix glob over a shell line, which cannot
      // enforce "only these executables": a permitted prefix still admits
      // pipelines, substitutions, and chained commands. Claiming equivalence
      // would be claiming enforcement that does not exist.
      return planFailure(
        "command-policy-untranslatable",
        "An executable allowlist cannot be expressed as a Claude Bash permission rule without weakening it.",
      );
    case "sandboxed":
      if (!grantAllowsOperation(input.grant, "command-execution")) {
        return planFailure("policy-denied", "The capability grant does not permit command execution.");
      }
      if (!input.commandExecutionAllowed) {
        return planFailure(
          "policy-denied",
          "Command execution has not been accepted for this execution backend.",
        );
      }
      tools.push(CLAUDE_TOOL_NAMES.bash);
      bashPermitted = true;
      break;
  }

  if (capabilities.has("run-tests")) {
    if (!capabilities.has("run-commands")) {
      return planFailure(
        "capability-missing",
        "Running tests requires the run-commands capability.",
      );
    }
    if (!bashPermitted) {
      return planFailure(
        "command-policy-untranslatable",
        "Running tests requires a command policy the adapter can translate exactly.",
      );
    }
  }

  if (input.networkPolicy === "proxied") {
    // Claude's own control-plane connection is not agent web access. Granting
    // the agent a proxied network would mean enabling WebFetch or an approved
    // MCP server, and neither can be contained by the current backends.
    return planFailure(
      "network-policy-unenforceable",
      "Proxied agent network access requires an execution backend that can enforce egress.",
    );
  }

  const unique = Object.freeze([...new Set(tools)].sort());
  return Object.freeze({
    ok: true as const,
    plan: Object.freeze({
      tools: unique,
      disallowedTools: Object.freeze([...ALWAYS_DENIED_TOOLS, MCP_DENY_RULE].sort()),
      bashPermitted,
      writePermitted: unique.includes(CLAUDE_TOOL_NAMES.write),
    }),
  });
}

export interface ClaudeInvocationInput {
  readonly configuration: ClaudeAdapterConfiguration;
  readonly capabilities: ClaudeCliCapabilities;
  readonly plan: ClaudeToolPlan;
  readonly model: string | null;
  readonly effort: ClaudeEffortLevel | null;
  readonly sessionId: string;
  /** Set only for a verified resume; mutually exclusive with a new session. */
  readonly resumeSessionId: string | null;
  readonly persistSession: boolean;
  readonly budgetMicros: number | null;
  readonly maxTurns: number;
}

export interface ClaudeInvocation {
  readonly args: readonly string[];
  readonly sessionId: string;
  readonly persistSession: boolean;
}

/**
 * Builds the argument vector. Every element is a literal from this module or a
 * value already validated against a pattern that forbids a leading `-`, so no
 * caller-controlled string can become a flag.
 */
export function buildInvocation(input: ClaudeInvocationInput): ClaudeInvocation {
  const { configuration, capabilities, plan } = input;
  const args: string[] = [];

  // Non-interactive machine-readable execution.
  args.push("--print");
  args.push("--output-format", "stream-json");
  args.push("--verbose");
  if (capabilities.partialMessages) {
    args.push("--include-partial-messages");
  }

  // Ambient customization sources off, defence in depth over the sandbox.
  args.push("--safe-mode");
  args.push("--no-chrome");
  args.push("--strict-mcp-config");
  if (capabilities.settingSources) {
    // An empty source list loads no user, project, or local settings file.
    args.push("--setting-sources", "");
  }

  // A finite built-in tool surface. The empty string disables all tools.
  args.push("--tools", plan.tools.length === 0 ? "" : plan.tools.join(","));
  args.push("--disallowed-tools", plan.disallowedTools.join(","));
  args.push("--permission-mode", CLAUDE_PERMISSION_MODE);

  if (input.model !== null) {
    if (!capabilities.modelSelection) {
      throw unsupportedCapabilityError("capability-missing", { capability: "model-selection" });
    }
    args.push("--model", assertNotFlag(input.model, "model"));
  }
  if (input.effort !== null) {
    if (!capabilities.effortSelection) {
      throw unsupportedCapabilityError("effort-unsupported", { capability: "effort-selection" });
    }
    args.push("--effort", assertNotFlag(input.effort, "effort"));
  }

  if (capabilities.maxTurns) {
    args.push("--max-turns", String(input.maxTurns));
  }
  if (input.budgetMicros !== null && input.budgetMicros > 0) {
    if (!capabilities.budgetCap) {
      throw unsupportedCapabilityError("capability-missing", { capability: "budget-cap" });
    }
    args.push("--max-budget-usd", microsToBudgetArgument(input.budgetMicros));
  }

  if (input.resumeSessionId !== null) {
    if (!capabilities.resume) {
      throw unsupportedCapabilityError("capability-missing", { capability: "resume" });
    }
    if (!isValidSessionId(input.resumeSessionId)) {
      throw invalidRequestError("resume-token-invalid");
    }
    args.push("--resume", input.resumeSessionId);
  } else {
    if (!capabilities.sessionId) {
      throw unsupportedCapabilityError("capability-missing", { capability: "session-id" });
    }
    if (!isValidSessionId(input.sessionId)) {
      throw invalidRequestError("resume-token-invalid");
    }
    args.push("--session-id", input.sessionId);
  }

  if (!input.persistSession) {
    if (!capabilities.sessionPersistenceControl) {
      throw unsupportedCapabilityError("capability-missing", { capability: "session-persistence" });
    }
    args.push("--no-session-persistence");
  }

  void configuration;
  return Object.freeze({
    args: Object.freeze(args),
    sessionId: input.resumeSessionId ?? input.sessionId,
    persistSession: input.persistSession,
  });
}

/**
 * Last-line defence against flag injection. Values reaching here have already
 * passed a pattern check; this makes the invariant explicit at the point the
 * argument vector is assembled, so a future pattern change cannot silently
 * allow an option-looking value through.
 */
function assertNotFlag(value: string, field: string): string {
  const text = ensureString(value, field, { maxLength: 64 });
  if (text.startsWith("-")) {
    throw invalidRequestError("configuration-invalid", { field, reason: "option-argument" });
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\u0000-\u001f\u007f]/.test(text) || text.includes(",")) {
    throw invalidRequestError("configuration-invalid", { field, reason: "unsafe-character" });
  }
  return text;
}

/**
 * Encodes task instructions for stdin. Placing them here rather than in argv
 * avoids command-line length limits, quoting ambiguity, disclosure through the
 * process list, and any possibility of flag injection.
 */
export function encodeInstructions(request: CodingAgentRequest, maxBytes: number): Uint8Array {
  const bytes = Buffer.from(request.instructions, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw invalidRequestError("configuration-invalid", {
      field: "instructions",
      byteLength: bytes.byteLength,
      maxBytes,
    });
  }
  return new Uint8Array(bytes);
}
