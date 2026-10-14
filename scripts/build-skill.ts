// Writes skills/teams-cli/SKILL.md from the CLI's help. `--check` fails on drift without writing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSkill } from "../src/skill.js";

const path = join(import.meta.dirname, "..", "skills", "teams-cli", "SKILL.md");
const next = renderSkill();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== next) {
    console.error("skills/teams-cli/SKILL.md is stale; run `npm run build:skill`");
    process.exit(1);
  }
  console.log("skill is up to date");
} else {
  writeFileSync(path, next);
  console.log(`wrote ${path}`);
}
