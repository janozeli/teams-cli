import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withLock } from "../src/lock.js";

describe("withLock", () => {
  it("serializes concurrent holders", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "teams-cli-")), "send.lock");
    const events: string[] = [];
    const job = (name: string) =>
      withLock(path, async () => {
        events.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 50));
        events.push(`${name}:out`);
      });
    await Promise.all([job("a"), job("b")]);
    expect(events).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });

  it("takes over a lock left by a dead process", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "teams-cli-")), "send.lock");
    writeFileSync(path, "999999999");
    await expect(withLock(path, async () => "ok", 500)).resolves.toBe("ok");
  });
});


it("does not steal a long-running live holder's lock", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "teams-cli-")), "send.lock");
  writeFileSync(path, String(process.pid));
  const old = new Date(Date.now() - 120_000); utimesSync(path, old, old);
  await expect(withLock(path, async () => "must not run", 1)).rejects.toMatchObject({code:"BUSY"});
});
it("does not remove a newly created lock before its pid is written", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "teams-cli-")), "send.lock");
  writeFileSync(path, "");
  await expect(withLock(path, async () => "must not run", 1)).rejects.toMatchObject({code:"BUSY"});
});
