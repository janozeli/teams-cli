import { parse } from "yaml";
import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedBrowser } from "./helpers/browser.js";
import { sessionSocketPath } from "../src/session-client.js";
import { readTrace } from "../src/trace.js";

it.each(["end", "disconnect"])("retains view/trace across separate callers, rejects replay and cleans up on %s", async termination => {
  const state = mkdtempSync(join(tmpdir(), "teams-cli-process-"));
  const oldState = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = state;
  const socket = sessionSocketPath();
  const browser = await isolatedBrowser();
  let worker: ChildProcess | undefined;
  const clients = new Set<ChildProcess>();
  try {
    const { page, session } = await browser.page();
    const env = { ...process.env, FIXTURE_TARGET: JSON.stringify(session.target) };
    worker = spawn(process.execPath, ["--import", "tsx", "test/helpers/fixture-owner.ts", socket], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("fixture owner did not start")), 10000);
      worker!.once("error", reject); worker!.once("exit", code => { clearTimeout(timer); reject(Error(`owner exited ${code}`)); });
      worker!.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const call = (request: Record<string, unknown>, capture?: (child: ChildProcess) => void) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/fixture-client.ts", JSON.stringify(request)], { env, stdio: ["ignore", "pipe", "pipe"] });
      clients.add(child); capture?.(child); let output = "", err = "";
      child.stdout!.on("data", b => { output += b; }); child.stderr!.on("data", b => { err += b; });
      child.once("error", reject); child.once("exit", code => {
        clients.delete(child);
        try { resolve({ ...JSON.parse(output), exitCode: code, notices: err }); } catch { reject(Error(`client ${code}: ${output} ${err}`)); }
      });
    });
    const first = call({ type: "command", command: "hold", args: [] });
    await page.waitForFunction(() => (globalThis as any).started);
    const root = page.locator("#teams-cli-activity-view");
    await root.getByRole("button", { name: "Pause", exact: true }).click();
    const busy = await call({ type: "command", command: "second", args: [] });
    expect(busy.error).toBe("UI_BUSY"); // never queued behind the blocked request
    await root.getByRole("button", { name: "Resume", exact: true }).click();
    const a = await first;
    expect(a.status).toBe("interrupted"); expect(a.exitCode).toBe(1); expect(a.notices).toContain("Pending steps will not execute");
    expect(await root.count()).toBe(1);
    const status = await call({ type: "status" });
    expect(status.busy).toBe(false); expect(status.trace.id).toBe(a.trace.id);
    const b = await call({ type: "command", command: "fresh", args: [] });
    expect(b.value).toBe(42); expect(b.exitCode).toBe(0); expect(b.trace.id).toBe(a.trace.id);
    expect(await page.evaluate(() => (globalThis as any).forbidden)).toBeUndefined();
    // Exercise the real CLI boundary across an already active owner, not just
    // the test client's JSON.stringify. Each caller chooses its own format.
    for (const format of ["yaml", "json"]) {
      const rendered = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "bin/teams-cli.ts", "read", "fixture", "--format", format], { env, stdio: ["ignore", "pipe", "pipe"] });
        clients.add(child); let text = "", stderr = "";
        child.stdout!.on("data", b => { text += b; }); child.stderr!.on("data", b => { stderr += b; });
        child.once("error", reject); child.once("exit", code => { clients.delete(child); code === 0 ? resolve(text) : reject(Error(stderr + text)); });
      });
      const decoded = format === "json" ? JSON.parse(rendered) : parse(rendered);
      expect(decoded.value).toBe(42);
      expect(decoded.trace.id).toBe(a.trace.id);
    }
    const events = readTrace(a.trace.id).events;
    expect(readTrace(a.trace.id).issues).toEqual([]);
    expect(events.filter(e => e.event === "command.received").map(e => e.data.command)).toEqual(["hold", "fresh", "read", "read"]);
    expect(new Set(events.filter(e => e.event === "command.received").map(e => e.commandId)).size).toBe(4);
    if (termination === "end") {
      const ended = await call({ type: "end" }); expect(ended.status).toBe("ended");
    } else {
      let pending!: ChildProcess;
      const broken = call({ type: "command", command: "hold", args: [] }, child => { pending = child; }).catch(() => undefined);
      await page.waitForFunction(() => (globalThis as any).started === 2);
      pending.kill("SIGTERM"); await broken;
      await expect.poll(() => readTrace(a.trace.id).events.at(-1)?.event, { timeout: 5000 }).toBe("session.ended");
      expect(readTrace(a.trace.id).events.some(e => e.event === "session.end.requested" && e.data.reason === "client-disconnected")).toBe(true);
      expect(await page.evaluate(() => (globalThis as any).forbidden)).toBeUndefined();
    }
    await expect.poll(() => root.count()).toBe(0);
    expect(readTrace(a.trace.id).events.at(-1)?.event).toBe("session.ended");
  } finally {
    for (const child of clients) child.kill("SIGTERM");
    if (worker && worker.exitCode === null) {
      const stopped = new Promise(resolve => worker!.once("exit", resolve)); worker.kill("SIGTERM"); await stopped;
    }
    await browser.close();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    rmSync(state, { recursive: true, force: true });
  }
}, 30000);
