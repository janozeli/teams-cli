import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setup } from "../src/setup.js";

// Every test runs against a throwaway home and project; the real agent configs are never touched.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "teams-cli-setup-"));
  const homeDir = join(root, "home");
  const projectDir = join(root, "proj");
  mkdirSync(homeDir);
  mkdirSync(projectDir);
  const entryPath = join(root, "pkg", "dist", "bin", "teams-cli-context.js");
  mkdirSync(join(root, "pkg", "dist", "bin"), { recursive: true });
  writeFileSync(entryPath, "#!/usr/bin/env node\n");
  return { homeDir, projectDir, entryPath };
}
const claude = (home: string) => join(home, ".claude", "settings.json");
const managed = (path: string) =>
  (JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>)
    .flatMap((g) => g.hooks)
    .filter((h) => h.command.includes("teams-cli"));

describe("setup hooks", () => {
  it("installs for Claude Code, Codex and OpenCode, idempotently", async () => {
    const env = sandbox();
    const first = await setup(["hooks"], env);
    expect(first).toMatchObject({ installed: { claude: { installed: true }, codex: { installed: true, hooksFeatureEnabled: true }, opencode: { installed: true } } });
    const before = readFileSync(claude(env.homeDir), "utf8");
    await setup(["hooks"], env);
    expect(readFileSync(claude(env.homeDir), "utf8")).toBe(before);
    expect(managed(claude(env.homeDir))).toHaveLength(1);
    expect(managed(claude(env.homeDir))[0].command).toContain("teams-cli-context.js");
  });

  it("collapses duplicate managed entries and keeps unrelated hooks", async () => {
    const env = sandbox();
    mkdirSync(join(env.homeDir, ".claude"));
    const dup = { type: "command", command: "/old/teams-cli-context.js" };
    const other = { type: "command", command: "echo hello" };
    writeFileSync(claude(env.homeDir), JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ hooks: [dup] }, { hooks: [dup, other] }] } }));
    const out = await setup(["hooks"], env);
    expect(out.repaired).toBeDefined();
    const settings = JSON.parse(readFileSync(claude(env.homeDir), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(managed(claude(env.homeDir))).toHaveLength(1);
    expect(JSON.stringify(settings)).toContain("echo hello");
  });

  it("reports status without writing, and uninstalls only its own entries", async () => {
    const env = sandbox();
    expect(await setup(["hooks", "--status"], env)).toMatchObject({ hooks: { claude: { installed: false } } });
    expect(existsSync(claude(env.homeDir))).toBe(false);
    await setup(["hooks"], env);
    const out = await setup(["hooks", "--uninstall"], env);
    expect(out).toMatchObject({ uninstalled: { claude: { installed: false }, codex: { installed: false }, opencode: { installed: false } } });
    await expect(setup(["hooks", "--uninstall"], env)).resolves.toBeDefined(); // twice is fine
  });

  it("supports project scope", async () => {
    const env = sandbox();
    const out = await setup(["hooks", "--scope", "project"], env);
    expect(out).toMatchObject({ installed: { scope: "project", claude: { path: join(env.projectDir, ".claude", "settings.json"), installed: true } } });
    expect(existsSync(claude(env.homeDir))).toBe(false);
  });

  it("refuses to install without a built context entrypoint", async () => {
    const env = sandbox();
    await expect(setup(["hooks"], { ...env, entryPath: join(env.homeDir, "missing.js") })).rejects.toMatchObject({ code: "SETUP_FAILED" });
    await expect(setup(["other"], env)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
