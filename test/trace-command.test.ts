import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceCommand } from "../src/trace-command.js";
import { currentOperation, withOperation, instrumentSession } from "../src/operation.js";
import { traceDirectory, readTrace } from "../src/trace.js";
import { audit, auditLogPath } from "../src/audit.js";
let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "teams-trace-cli-")); vi.stubEnv("XDG_STATE_HOME", state); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(state, { recursive: true, force: true }); process.exitCode = 0; });

it("inspects valid traces without accessing Teams or creating another operation", async () => {
  const result: any = await withOperation("fixture", async () => ({ ok: true }));
  const id = result.trace.id;
  const raw = await traceCommand([id, "--raw"]);
  expect(String(raw).trimEnd().split("\n").map(line => JSON.parse(line)).map(e => e.event)).toEqual(["command.received", "command.completed"]);
  expect(await traceCommand([id, "--validate"])).toMatchObject({ valid: true, terminalRecordObserved: true });
  expect(JSON.stringify(await traceCommand([id, "--at-seq", "1"]))).toContain("append sequence");
  expect(raw).toBe(readFileSync(result.trace.path, "utf8"));
  expect(readdirSync(traceDirectory())).toEqual([id + ".jsonl"]);
});
it("signals partial evidence instead of silently accepting a corrupt tail", async () => {
  const result: any = await withOperation("fixture", async () => ({}));
  appendFileSync(result.trace.path, '{"incomplete":');
  expect(await traceCommand([result.trace.id])).toMatchObject({ reconstruction: expect.stringContaining("non-authoritative") });
  expect(await traceCommand([result.trace.id, "--raw"])).toBe(readFileSync(result.trace.path, "utf8")); expect(process.exitCode).toBe(1);
});
it("refuses conflicting query modes and path traversal", async () => {
  await expect(traceCommand(["../elsewhere"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(traceCommand(["id", "--raw", "--at-seq", "2"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});
it("puts selected action metadata into the same file without retaining message content", async () => {
  const result: any = await withOperation("fixture", async () => {
    audit({ action: "edit", phase: "attempt", html: "SECRET_NEW", before: "SECRET_OLD", error: "SECRET_ERROR" });
    audit({ action: "edit", status: "edited" });
    return { log: auditLogPath() };
  });
  expect(result.log).toBe(result.trace.path); expect(readdirSync(traceDirectory())).toHaveLength(1);
  const trace = readTrace(result.trace.id);
  expect(trace.events.map(e => e.event)).toContain("action.outcome"); expect(JSON.stringify(trace)).not.toContain("SECRET");
});
it("never dispatches when required recording is unavailable", async () => {
  let dispatched = false;
  await expect(withOperation("fixture", async () => {
    currentOperation()!.trace.close();
    const session = instrumentSession({ target: { id: "fake", title: "", type: "page", url: "", webSocketDebuggerUrl: "" },
      run: async <T>() => { dispatched = true; return true as T; }, cdp: async () => { dispatched = true; return {}; } });
    return session.run("true");
  })).rejects.toMatchObject({ code: "TRACE_UNAVAILABLE" });
  expect(dispatched).toBe(false);
});
