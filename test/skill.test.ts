import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_HELP } from "../src/help.js";
import { renderSkill } from "../src/skill.js";

describe("agent skill", () => {
  it("is committed up to date with the CLI help (run `npm run build:skill`)", () => {
    const committed = readFileSync(join(import.meta.dirname, "..", "skills", "teams-cli", "SKILL.md"), "utf8");
    expect(committed).toBe(renderSkill());
  });

  it("has trigger-shaped frontmatter and every command's help", () => {
    const skill = renderSkill();
    expect(skill).toMatch(/^---\nname: teams-cli\ndescription: >\n/);
    for (const help of Object.values(COMMAND_HELP)) expect(skill).toContain(help.trimEnd());
  });
});
