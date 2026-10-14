import { CliError } from "./errors.js";

export type FlagType = "boolean" | "string" | "number";

export interface ArgSpec {
  command: string;
  flags: Record<string, FlagType>;
  /** Names of positional arguments, in order; all are required unless listed in `optional`. */
  positionals?: string[];
  optional?: string[];
  usage: string;
}

export interface Parsed {
  positionals: Record<string, string | undefined>;
  flags: Record<string, string | number | boolean | undefined>;
}

const usageError = (message: string, spec: ArgSpec, extra: string[] = []) =>
  new CliError(message, "VALIDATION_ERROR", [...extra, `usage: ${spec.usage}`]);

/** Strict parser: reject unknown flags and surplus positional arguments. */
export function parseArgs(args: string[], spec: ArgSpec): Parsed {
  const flags: Parsed["flags"] = {};
  const rest: string[] = [];
  const known = Object.keys(spec.flags);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    const type = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
    if (!type) {
      throw usageError(`unknown flag --${name} for \`${spec.command}\``, spec, [
        `valid flags for \`${spec.command}\`: ${known.map((f) => `--${f}`).join(", ") || "(none)"} (--help always allowed)`,
      ]);
    }
    if (type === "boolean") {
      if (eq > 0) throw usageError(`--${name} takes no value`, spec);
      flags[name] = true;
      continue;
    }
    let value: string | undefined = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
    // Never swallow the next flag as a value: `--text --dry-run` must not send "--dry-run".
    if (value === undefined || (eq < 0 && value.startsWith("--"))) {
      throw usageError(`--${name} requires a value`, spec, [`To pass a value starting with "--", use --${name}=<value>`]);
    }
    if (eq < 0) i++;
    if (type === "number") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw usageError(`--${name} must be a positive integer, got "${value}"`, spec);
      flags[name] = n;
    } else {
      flags[name] = value;
    }
  }
  const names = spec.positionals ?? [];
  if (rest.length > names.length) {
    throw usageError(`unexpected argument "${rest[names.length]}" for \`${spec.command}\``, spec, [
      "Quote multi-word values, e.g. \"Alex Morgan\"",
    ]);
  }
  const positionals: Parsed["positionals"] = {};
  names.forEach((n, i) => {
    positionals[n] = rest[i];
    if (rest[i] === undefined && !(spec.optional ?? []).includes(n)) {
      throw usageError(`missing <${n}> for \`${spec.command}\``, spec);
    }
  });
  return { positionals, flags };
}
