export const TASK_GRAPH_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_SNAPSHOT",
  "DUPLICATE_TASK",
  "UNKNOWN_TASK",
  "GRAPH_SEALED",
  "GRAPH_NOT_SEALED",
  "EMPTY_GRAPH",
  "CYCLIC_DEPENDENCY",
  "GRAPH_LIMIT_EXCEEDED",
  "INVALID_TRANSITION",
  "CONCURRENCY_CONFLICT",
  "REENTRANT_MUTATION",
] as const;

export type TaskGraphErrorCode = (typeof TASK_GRAPH_ERROR_CODES)[number];

export class TaskGraphError extends Error {
  readonly code: TaskGraphErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TaskGraphErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TaskGraphError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
