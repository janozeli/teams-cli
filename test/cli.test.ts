import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Executable-level contract: exit codes and structured stdout, with CDP pointed
// at a closed port so no Teams instance is ever touched.
const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => {
  const state = mkdtempSync(join(tmpdir(), "teams-cli-cli-"));
  const r = spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "bin/teams-cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, TEAMS_CLI_CDP_URL: "http://127.0.0.1:9", XDG_STATE_HOME: state },
  });
  rmSync(state, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("teams-cli executable", () => {
  it("prints the bare version", () => {
    expect(cli("--version")).toMatchObject({ code: 0, out: "0.1.0\n" });
  });

  it("exits 1 with a structured error when CDP is unreachable", () => {
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: CDP_UNREACHABLE");
  });

  it.each([["chats", "--bogus"], ["read"], ["send", "me", "--text", "--dry-run"], ["nope"]])("rejects usage errors before CDP: %s", (...args) => {
    const r = cli(...args);
    expect(r.code, args.join(" ")).toBe(2);
    expect(r.out).toMatch(/^error: /m);
  });

  it("treats --text=--help as message content, not a help request", () => {
    const r = cli("send", "me", "--text=--help", "--dry-run");
    expect(r.out).not.toContain("usage: teams-cli send");
    expect(r.out).toContain("code: CDP_UNREACHABLE"); // got past parsing to the chat lookup
  });

  it("prints per-command help", () => {
    const r = cli("send", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("--markdown");
  });
});


describe("CLI serialization boundary", () => {
  it("renders command and usage errors as JSON with the requested exit code", () => {
    for (const [args, code, error] of [
      [["--format", "json", "chats"], 1, "CDP_UNREACHABLE"],
      [["nope", "--format=json"], 2, "VALIDATION_ERROR"],
      [["read", "--format", "json"], 2, "VALIDATION_ERROR"],
    ] as const) {
      const r = cli(...args);
      expect(r.code).toBe(code);
      expect(JSON.parse(r.out).code).toBe(error);
      if (code === 1) expect(JSON.parse(r.out).trace.id).toEqual(expect.any(String));
      expect(r.err).toBe("");
    }
  });
  it("renders local results and help in both formats", () => {
    const yaml = cli("session", "status");
    const json = cli("session", "status", "--format", "json");
    expect(parse(yaml.out)).toEqual(JSON.parse(json.out));
    expect(JSON.parse(json.out)).toEqual({ status: "inactive" });
    expect(JSON.parse(cli("--format", "json", "--help").out).help).toContain("commands:");
    expect(JSON.parse(cli("--version", "--format", "json").out)).toEqual({ version: "0.1.0" });
  });
  it.each([
    ["--format", "csv", "chats"], ["chats", "--format"],
    ["--format=json", "chats", "--format=yaml"], ["trace", "x", "--raw", "--format=json"],
  ])("rejects unsupported or conflicting output choices: %s", (...args) => {
    const r = cli(...args);
    expect(r.code).toBe(2);
    expect(parse(r.out).code).toBe("VALIDATION_ERROR");
  });
});
