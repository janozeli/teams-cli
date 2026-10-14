import { describe, expect, it } from "vitest";
import { parseArgs, type ArgSpec } from "../src/args.js";

const spec: ArgSpec = {
  command: "read",
  flags: { limit: "number", full: "boolean", text: "string" },
  positionals: ["chat"],
  usage: "teams-cli read <chat>",
};

describe("parseArgs", () => {
  it("parses positionals and typed flags in both forms", () => {
    expect(parseArgs(["Ana", "--limit", "5", "--full", "--text=a=b"], spec)).toEqual({
      positionals: { chat: "Ana" },
      flags: { limit: 5, full: true, text: "a=b" },
    });
  });

  it("rejects unknown flags, listing the valid ones", () => {
    expect(() => parseArgs(["Ana", "--limt", "5"], spec)).toThrow(/unknown flag --limt/);
    try {
      parseArgs(["Ana", "--limt"], spec);
    } catch (e) {
      expect((e as { code: string }).code).toBe("VALIDATION_ERROR");
      expect((e as { suggestions: string[] }).suggestions[0]).toContain("--limit, --full, --text");
    }
  });

  it("rejects missing and surplus positionals and bad numbers", () => {
    expect(() => parseArgs([], spec)).toThrow(/missing <chat>/);
    expect(() => parseArgs(["Ana", "Lima"], spec)).toThrow(/unexpected argument "Lima"/);
    expect(() => parseArgs(["Ana", "--limit", "0"], spec)).toThrow(/positive integer/);
    expect(() => parseArgs(["Ana", "--full=yes"], spec)).toThrow(/takes no value/);
  });

  it("never swallows the next flag as a value", () => {
    expect(() => parseArgs(["Ana", "--text", "--full"], spec)).toThrow(/--text requires a value/);
    expect(parseArgs(["Ana", "--text=--full"], spec).flags).toEqual({ text: "--full" });
  });

  it("does not accept inherited property names as flags", () => {
    expect(() => parseArgs(["Ana", "--toString", "x"], spec)).toThrow(/unknown flag --toString/);
  });

  it("treats everything after -- as positional", () => {
    expect(parseArgs(["--", "--weird"], spec).positionals.chat).toBe("--weird");
  });
});
