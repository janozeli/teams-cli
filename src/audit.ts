import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { currentOperation } from "./operation.js";

export function uiLockPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "teams-cli", "send.lock");
}
/** Legacy internal name retained; all new audit events share the operation's trace. */
export function auditLogPath(): string {
  const operation = currentOperation();
  if (!operation) throw new CliError("An operation context is required for recording", "TRACE_UNAVAILABLE");
  return operation.trace.path;
}

/** Whitelist outcome metadata; never copy messages, previous text, errors or raw payloads. */
export function audit(entry: Record<string, unknown>): void {
  const operation = currentOperation();
  if (!operation) throw new CliError("An operation context is required for recording", "TRACE_UNAVAILABLE");
  const data: Record<string, unknown> = {};
  for (const key of ["action", "attempt", "phase", "status", "confirmation", "code"])
    if (typeof entry[key] === "string") data[key] = entry[key];
  operation.trace.append({ actor: "system", component: "executor", event: entry.phase === "attempt" ? "action.attempt" : "action.outcome",
    evidence: entry.phase === "attempt" ? "intent" : "assessment", data });
}
