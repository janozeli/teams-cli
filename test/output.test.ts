import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { renderOutput } from "../src/output.js";
import { invocation } from "../src/cli.js";

describe("output formats", () => {
  it("preserves JSON types and difficult message strings without aliases or wrapping", () => {
    const result = { id: "17901924359510000001", ids: ["01", "true", "null", "2026-09-25", "yes", "1e6"], count: 0,
      empty: [], absent: null, ok: false, text: '\nfirst\r\n"quoted": # text\n---\nend\n\n', emoji: "Olá 👋", long: "x".repeat(600),
      nested: [{ data: [1, true, null] }] };
    expect(parse(renderOutput(result))).toEqual(result);
    expect(JSON.parse(renderOutput(result, "json"))).toEqual(result);
    expect(renderOutput(result)).toContain("x".repeat(600));
  });
  it("keeps interrupted progress and trace equally accessible in either format", () => {
    const result = { status: "interrupted", pendingStepsWillExecute: false, progress: { steps: [], uncertain: true }, trace: { id: "1", commandId: "2", inspect: "teams-cli trace 1" } };
    expect(parse(renderOutput(result))).toEqual(JSON.parse(renderOutput(result, "json")));
  });
  it("selects format before or after a command", () => {
    for (const argv of [["--format", "json", "read", "me"], ["read", "me", "--format=json"]]) {
      const selection = { format: "yaml" as const, explicit: false };
      expect(invocation(argv, selection)).toEqual({ command: "read", args: ["me"], help: false });
      expect(selection.format).toBe("json");
    }
  });
  it("does not reinterpret literal message text or positional values as global options", () => {
    for (const argv of [["send", "me", "--text", "--format=json"], ["send", "me", "--text=--format=json"], ["read", "--", "--format=json"]]) {
      const selection = { format: "yaml" as const, explicit: false };
      expect(invocation(argv, selection).args).toEqual(argv.slice(1));
      expect(selection.explicit).toBe(false);
    }
  });
});
