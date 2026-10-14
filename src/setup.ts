import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks, type SessionStartHookScope } from "./vendor/axi-hooks/hooks.js";
import { parseArgs, type ArgSpec } from "./args.js";

const MARKER = "teams-cli";
const ENTRY = "teams-cli-context";

export const setupSpec: ArgSpec = {
  command: "setup",
  flags: { scope: "string", uninstall: "boolean", status: "boolean" },
  positionals: ["what"],
  usage: "teams-cli setup hooks [--scope user|project] [--status | --uninstall]",
};

export interface SetupEnv {
  homeDir?: string;
  projectDir?: string;
  /** Path of the compiled context entrypoint; defaults to the one next to this CLI. */
  entryPath?: string;
}

/** Count managed SessionStart entries in a Claude/Codex hooks JSON (duplicates are not repaired by the SDK). */
function managedCount(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const hooks = JSON.parse(readFileSync(path, "utf8"))?.hooks?.SessionStart;
    if (!Array.isArray(hooks)) return 0;
    return hooks.flatMap((g: { hooks?: Array<{ command?: string }> }) => g.hooks ?? []).filter((h) => h.command?.includes(MARKER)).length;
  } catch {
    return 0;
  }
}

export async function setup(args: string[], env: SetupEnv = {}): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(args, setupSpec);
  if (positionals.what !== "hooks") {
    throw new CliError(`unknown setup target "${positionals.what}"`, "VALIDATION_ERROR", [`usage: ${setupSpec.usage}`]);
  }
  const scope = (flags.scope ?? "user") as SessionStartHookScope;
  if (scope !== "user" && scope !== "project") {
    throw new CliError("--scope must be user or project", "VALIDATION_ERROR", [`usage: ${setupSpec.usage}`]);
  }
  if (flags.status && flags.uninstall) {
    throw new CliError("--status and --uninstall are exclusive", "VALIDATION_ERROR", [`usage: ${setupSpec.usage}`]);
  }
  const execPath = resolve(env.entryPath ?? join(dirname(process.argv[1] ?? ""), `${ENTRY}.js`));
  const base = { marker: MARKER, scope, homeDir: env.homeDir, projectDir: env.projectDir };
  const errors: string[] = [];
  const onError = (m: string) => errors.push(m);

  const report = () => {
    const s = sessionStartHookStatus({ ...base, execPath });
    return {
      scope,
      claude: { installed: s.claude.installed, path: s.claude.path },
      codex: { installed: s.codex.installed, path: s.codex.path, hooksFeatureEnabled: s.codex.userFeatureEnabled },
      opencode: { installed: s.opencode.installed, path: s.opencode.path },
    };
  };

  if (flags.status) return { hooks: report() };

  if (flags.uninstall) {
    uninstallSessionStartHooks({ ...base, execPath, onError });
    const after = report();
    if (errors.length) throw new CliError("Some hooks could not be removed", "SETUP_FAILED", errors);
    return { uninstalled: after, note: "Codex's user-level [features].hooks flag is shared by hook integrations and is left as is" };
  }

  if (!execPath.endsWith(".js") || !existsSync(execPath)) {
    throw new CliError(`Context entrypoint not found at ${execPath}`, "SETUP_FAILED", [
      "Run setup from the built CLI (`npm run build`, then `node dist/bin/teams-cli.js setup hooks` or the linked `teams-cli`)",
    ]);
  }
  const opts = {
    ...base,
    execPath,
    binaryNames: [ENTRY],
    distEntrypoints: [`dist/bin/${ENTRY}.js`],
    timeoutSeconds: 10,
    onError,
  };
  const s = sessionStartHookStatus({ ...base, execPath });
  const dupes = [s.claude.path, s.codex.path].some((p) => managedCount(p) > 1);
  // The SDK repairs the first managed entry only; reinstall cleanly when duplicates exist.
  if (dupes) uninstallSessionStartHooks({ ...base, execPath, onError });
  installSessionStartHooks(opts);
  const after = report();
  const missing = (["claude", "codex", "opencode"] as const).filter((a) => !after[a].installed);
  if (errors.length || missing.length) {
    throw new CliError(`Hooks not fully installed${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`, "SETUP_FAILED", errors);
  }
  return {
    installed: after,
    ...(dupes ? { repaired: "duplicate managed hooks were collapsed into one" } : {}),
    help: [
      "New Claude Code and OpenCode sessions now start with a one-line Teams unread summary",
      "Codex runs a new hook only after you trust it: open `codex` and approve it (startup prompt or /hooks)",
      "Run `teams-cli setup hooks --uninstall` to remove it",
    ],
  };
}
