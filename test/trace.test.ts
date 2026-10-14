import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TraceWriter, readTrace, assertEvent, reconstruct, summarizeTrace, validateRelations } from "../src/trace.js";
import { TRACE_SCHEMA } from "../src/trace-schema.js";
const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "teams-trace-")); dirs.push(dir); return { dir, writer: new TraceWriter(dir) }; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const base = { actor: "system" as const, component: "executor" as const, evidence: "observation" as const };
it("appends immutable private records and preserves occurrence versus recording timestamps", () => {
  const { dir, writer } = fixture();
  const e = writer.append({ ...base, event: "operation.started", timestamp: "2020-01-01T00:00:00.000Z", timestampSource: "source" });
  const prefix = readFileSync(writer.path, "utf8");
  writer.append({ ...base, event: "operation.completed" }); writer.close();
  expect(readFileSync(writer.path, "utf8").startsWith(prefix)).toBe(true);
  expect(statSync(writer.path).mode & 0o777).toBe(0o600);
  expect(e.recordedAt).not.toBe(e.timestamp);
  const read = readTrace(writer.operationId, dir); expect(read.issues).toEqual([]); expect(read.events.map(e => e.seq)).toEqual([1, 2]);
});
it("reconstructs explicit supersession and as-recorded knowledge independently of physical line order", () => {
  const { dir, writer } = fixture(); const stepId = randomUUID();
  const start = writer.append({ ...base, actor: "agent", evidence: "intent", event: "step.started", stepId, data: { action: "send.click" } });
  const unknown = writer.append({ ...base, evidence: "assessment", event: "step.outcome.unknown", stepId, refs: [start.eventId], data: { outcome: "unknown" }, uncertainty: { reason: "Response lost" } });
  writer.append({ ...base, evidence: "assessment", event: "step.outcome.confirmed", stepId, supersedes: [unknown.eventId], refs: [start.eventId], data: { outcome: "sent" } });
  writer.close();
  const events = readTrace(writer.operationId, dir).events;
  expect(reconstruct(events.reverse()).steps[0].outcome).toBe("sent");
  expect(reconstruct(events, 2).steps[0].outcome).toBe("unknown");
  expect(validateRelations(events)).toEqual([]);
});
it("does not infer non-execution from a missing result and never repairs a crashed tail in place", () => {
  const { dir, writer } = fixture(); writer.append({ ...base, event: "step.started", stepId: randomUUID(), data: { action: "send.click" } }); writer.close();
  appendFileSync(writer.path, '{"partial":'); const before = readFileSync(writer.path, "utf8");
  const read = readTrace(writer.operationId, dir);
  expect(read.incomplete).toBe(true); expect(read.issues[0]).toContain("incomplete");
  expect(reconstruct(read.events).steps[0].outcome).toBe("unknown"); expect(readFileSync(writer.path, "utf8")).toBe(before);
});
it("rejects causal cycles, dangling refs, duplicate identities and replacing facts with assessments", () => {
  const { writer } = fixture(); const stepId = randomUUID();
  const a = writer.append({ ...base, event: "step.started", stepId });
  const b = writer.append({ ...base, evidence: "assessment", event: "step.completed", stepId, data: { outcome: "completed" } }); writer.close();
  expect(validateRelations([{ ...a, causedBy: [b.eventId] }, { ...b, causedBy: [a.eventId], supersedes: [a.eventId], refs: [randomUUID()] }, a]).join(" ")).toMatch(/Duplicate/);
  const errors = validateRelations([{ ...a, causedBy: [b.eventId] }, { ...b, causedBy: [a.eventId], supersedes: [a.eventId], refs: [randomUUID()] }]).join(" ");
  expect(errors).toContain("Causal cycle"); expect(errors).toContain("Unresolved"); expect(errors).toContain("Invalid assessment supersession");
});
it("validates enums/UTC timestamps and checks the published schema has not drifted", () => {
  const { writer } = fixture(); const e = writer.append({ ...base, event: "command.received" }); writer.close();
  expect(() => assertEvent({ ...e, actor: "probably-user" })).toThrow();
  expect(() => assertEvent({ ...e, recordedAt: "yesterday" })).toThrow();
  expect(() => assertEvent({ ...e, recordedAt: "2026-09-24T12:00:00+03:00" })).toThrow();
  for (const example of TRACE_SCHEMA.examples) expect(() => assertEvent(example)).not.toThrow();
  expect(JSON.parse(readFileSync("schemas/trace-event.v1.schema.json", "utf8"))).toEqual(TRACE_SCHEMA);
});
it("reports malformed middle records without rewriting or silently treating the trace as complete", () => {
  const { dir, writer } = fixture(); writer.append({ ...base, event: "operation.started" }); writer.close();
  appendFileSync(writer.path, 'invalid\n'); expect(readTrace(writer.operationId, dir).issues).toEqual(["Invalid record at line 2"]);
});

it("preserves conflicting assessments until explicit supersession reconciles them", () => {
  const { writer } = fixture(); const stepId = randomUUID();
  const start = writer.append({ ...base, event: "step.started", stepId });
  const a = writer.append({ ...base, evidence: "assessment", event: "step.completed", stepId, data: { outcome: "completed" } });
  const b = writer.append({ ...base, evidence: "assessment", event: "step.outcome.unknown", stepId, data: { outcome: "unknown" } });
  expect(reconstruct([b, start, a]).steps[0].outcome).toBe("conflicting_assessments");
  const c = writer.append({ ...base, evidence: "assessment", event: "step.outcome.confirmed", stepId, supersedes: [a.eventId, b.eventId], data: { outcome: "completed" } });
  expect(reconstruct([c, b, start, a]).steps[0].outcome).toBe("completed"); writer.close();
});

it("groups consecutive input through derived gate records, preserves other actions, and bounds summaries only", () => {
  const { dir, writer } = fixture();
  for (let i = 0; i < 50; i++) {
    writer.append({ ...base, actor: "unknown", component: "ui", event: "input.observed", data: { type: "pointermove", target: { tag: "div" } } });
    writer.append({ ...base, component: "activity-gate", event: "gate.deadline.reset" });
  }
  writer.append({ ...base, actor: "agent", event: "agent.action.completed", data: { action: "click" } });
  for (let i = 0; i < 15; i++) writer.append({ ...base, actor: "unknown", component: "ui", event: "input.observed", data: { type: "click", target: { tag: "button", tid: String(i) } } });
  writer.close(); const read = readTrace(writer.operationId, dir);
  expect(read.events).toHaveLength(116); expect(reconstruct(read.events).activity[0].repeats).toBe(50);
  expect(reconstruct(read.events).activity[0].throughSeq).toBe(99);
  expect(summarizeTrace(read.events).activity).toHaveLength(12);
  expect(summarizeTrace(read.events).omitted.earlierActivityGroups).toBe(4);
});
