import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";
import { parseArgs, type ArgSpec } from "./args.js";
import { readTrace, summarizeTrace, tracePath } from "./trace.js";
import { untrustedResult } from "./untrusted.js";

export const traceSpec: ArgSpec = {
  command: "trace", flags: { raw: "boolean", validate: "boolean", "at-seq": "number" }, positionals: ["operationId"],
  usage: "teams-cli trace <operationId> [--raw | --validate | --at-seq <n>]",
};
/** Inspection is local, read-only, and deliberately does not recursively create another trace. */
export async function traceCommand(args: string[]): Promise<Record<string, unknown> | string> {
  const { positionals, flags } = parseArgs(args, traceSpec);
  if ([flags.raw, flags.validate, flags["at-seq"]].filter(Boolean).length > 1)
    throw new CliError("Choose one of --raw, --validate or --at-seq", "VALIDATION_ERROR");
  const id = positionals.operationId!;
  const read = readTrace(id);
  if (read.issues.length) process.exitCode = 1;
  if (flags.raw) return readFileSync(tracePath(id), "utf8");
  const terminal = read.events.some(e => ["command.completed", "command.failed", "command.cancelled", "command.interrupted"].includes(e.event));
  const head = { trace: id, schemaVersion: "1", records: read.events.length, valid: !read.issues.length,
    terminalRecordObserved: terminal, sessionEnded: read.events.some(e => e.event === "session.ended"), issues: read.issues, note: "A command terminal record does not end a persistent session. Missing terminal records may mean running work or an unclean exit; absence never proves non-execution." };
  if (flags.validate) return head;
  return untrustedResult(head, { ...summarizeTrace(read.events, flags["at-seq"] as number | undefined),
    reconstruction: read.issues.length ? "Partial, non-authoritative: resolve validation issues before relying on relationships" : "Available recorded evidence" }, {
    fullTrace: `teams-cli trace ${id} --raw`, path: tracePath(id),
  });
}
