import { homedir } from "node:os";
import { CliError, errorOutput, exitCodeForError } from "./errors.js";
import { renderOutput, type OutputFormat } from "./output.js";
import { traceCommand, traceSpec } from "./trace-command.js";
import { runSessionCommand, sessionCommand } from "./session-client.js";
import * as commands from "./commands.js";
import { COMMAND_HELP, DESCRIPTION, TOP_LEVEL_HELP } from "./help.js";
import { setup, setupSpec } from "./setup.js";
import { VERSION } from "./version.js";
import type { ArgSpec } from "./args.js";

const specs: Record<string, ArgSpec> = Object.fromEntries([
  commands.chatsSpec, commands.readSpec, commands.sendSpec, commands.editSpec,
  commands.reactSpec, commands.waitSpec, commands.watchSpec, commands.activitySpec,
  commands.searchSpec, commands.presenceSpec, commands.peopleSpec, commands.callsSpec,
  commands.calendarSpec, commands.attachmentsSpec, traceSpec, setupSpec,
].map(s => [s.command, s]));
const handlers: Record<string, (args: string[]) => Promise<unknown>> = {
  ...Object.fromEntries(["chats", "read", "send", "edit", "react", "doctor", "activity", "search", "wait", "watch", "presence", "people", "calls", "calendar", "attachments"].map(command => [command, (args: string[]) => runSessionCommand(command, args)])),
  trace: traceCommand, session: sessionCommand, setup, update: commands.update,
};

/** Consume only global options, never their look-alikes in message/option values. */
export function invocation(argv: string[], selection: { format: OutputFormat; explicit: boolean }) {
  const args: string[] = [];
  let command: string | undefined, help = false, literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal) { args.push(arg); continue; }
    if (arg === "--") { literal = true; args.push(arg); continue; }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? argv[++i] : arg.slice("--format=".length);
      if (selection.explicit) throw new CliError("Specify --format only once", "VALIDATION_ERROR");
      if (value !== "yaml" && value !== "json") throw new CliError("--format must be yaml or json", "VALIDATION_ERROR");
      selection.format = value; selection.explicit = true;
      continue;
    }
    if (arg === "--help") { help = true; continue; }
    if (!command) { command = arg; continue; }
    args.push(arg);
    const type = specs[command]?.flags[arg.slice(2)];
    if (arg.startsWith("--") && !arg.includes("=") && type && type !== "boolean" && i + 1 < argv.length) args.push(argv[++i]);
  }
  return { command, args, help };
}

let stdoutHandled = false;
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (!stdoutHandled) {
    stdoutHandled = true;
    process.stdout.on("error", error => {
      if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exitCode = 0;
      else throw error;
    });
  }
  const selection = { format: "yaml" as OutputFormat, explicit: false };
  try {
    const { command, args, help } = invocation(argv, selection);
    if (command && ["--version", "-v", "-V"].includes(command) && !args.length && !help) {
      process.stdout.write(selection.explicit ? renderOutput({ version: VERSION }, selection.format) + "\n" : VERSION + "\n");
      return;
    }
    if (command && !Object.hasOwn(handlers, command)) throw new CliError(`Unknown command: ${command}`, "VALIDATION_ERROR", ["Run `teams-cli --help` to see available commands"]);
    if (help) {
      const reference = command ? COMMAND_HELP[command] : TOP_LEVEL_HELP;
      if (!reference) throw new CliError(`No help for ${command}`, "VALIDATION_ERROR");
      process.stdout.write(selection.explicit ? renderOutput({ help: reference }, selection.format) + "\n" : reference);
      return;
    }
    if (!command && args.length) throw new CliError("Expected a command before arguments", "VALIDATION_ERROR");
    if (command === "trace" && args.includes("--raw") && selection.explicit) throw new CliError("trace --raw returns JSONL; do not combine it with --format", "VALIDATION_ERROR");
    const result = command ? await handlers[command](args) : await runSessionCommand("home");
    if (command === "trace" && args.includes("--raw")) {
      process.stdout.write(String(result));
      return;
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) throw new CliError("Command must return an object", "OUTPUT_INVALID");
    let output = result;
    if (!command) {
      const { bin: _bin, description: _description, ...data } = result as Record<string, unknown>;
      const path = process.argv[1] ?? "teams-cli";
      output = { bin: path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path, description: DESCRIPTION, ...data };
    }
    process.stdout.write(renderOutput(output, selection.format) + "\n");
  } catch (error) {
    process.exitCode = exitCodeForError(error);
    process.stdout.write(renderOutput(errorOutput(error), selection.format) + "\n");
  }
}
