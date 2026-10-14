/** Stable domain errors, independent of the CLI serializer. */
export class CliError extends Error {
  trace?: Record<string, unknown>;
  constructor(message: string, public code: string, public suggestions: string[] = []) {
    super(message);
    this.name = "CliError";
  }
}
export function exitCodeForError(error: unknown): number {
  return error instanceof CliError && error.code === "VALIDATION_ERROR" ? 2 : 1;
}
export function errorOutput(error: unknown): Record<string, unknown> {
  const known = error instanceof CliError;
  return {
    error: error instanceof Error ? error.message : String(error),
    code: known ? error.code : "UNKNOWN",
    ...(known && error.trace ? { trace: error.trace } : {}),
    ...(known && error.suggestions.length ? { help: error.suggestions } : {}),
  };
}
