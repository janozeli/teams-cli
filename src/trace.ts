import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { CliError } from "./errors.js";
import { TRACE_SCHEMA } from "./trace-schema.js";

export type Actor = "agent" | "user" | "application" | "system" | "unknown";
export type Component = "cli" | "executor" | "cdp" | "ui" | "activity-gate" | "trace";
export interface TraceEvent {
  schemaVersion: "1"; eventId: string; operationId: string; commandId: string; stepId?: string;
  seq: number; timestamp: string; timestampSource: "source" | "observer"; recordedAt: string; clockId?: string;
  actor: Actor; component: Component; event: string; evidence: "observation" | "intent" | "assessment";
  refs?: string[]; causedBy?: string[]; supersedes?: string[];
  uncertainty?: { reason: string; needs?: string[] };
  data: Record<string, unknown>;
}
export type EventInput = Pick<TraceEvent, "actor" | "component" | "event" | "evidence"> &
  Partial<Pick<TraceEvent, "stepId" | "refs" | "causedBy" | "supersedes" | "uncertainty" | "timestamp" | "timestampSource" | "clockId" | "data">>;
const ajv = new Ajv({ allErrors: true });
(addFormats as unknown as (a: Ajv) => void)(ajv);
const validateEvent = ajv.compile(TRACE_SCHEMA);
export function traceDirectory(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "teams-cli", "traces");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function tracePath(id: string, directory = traceDirectory()): string {
  if (!UUID.test(id)) throw new CliError("Use an operation UUID from a command's trace reference", "VALIDATION_ERROR");
  return join(directory, id + ".jsonl");
}
export function assertEvent(value: unknown): asserts value is TraceEvent {
  if (!validateEvent(value)) throw new CliError("Trace event violates schema v1: " + ajv.errorsText(validateEvent.errors), "TRACE_INVALID");
}

/** One synchronous append writer per operation; acknowledged dispatches are preceded by durable intent. */
export class TraceWriter {
  readonly operationId = randomUUID();
  commandId = randomUUID();
  readonly path: string;
  private fd: number;
  private seq = 0;
  private closed = false;
  constructor(directory = traceDirectory()) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.path = tracePath(this.operationId, directory);
      this.fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND, 0o600);
    } catch { throw new CliError("Could not create the required operation trace", "TRACE_UNAVAILABLE"); }
  }
  append(input: EventInput): TraceEvent {
    if (this.closed) throw new CliError("Trace is closed; no further actions may execute", "TRACE_UNAVAILABLE");
    const recordedAt = new Date().toISOString();
    const event: TraceEvent = {
      ...input, schemaVersion: "1", eventId: randomUUID(), operationId: this.operationId, commandId: this.commandId,
      seq: this.seq + 1, timestamp: input.timestamp ?? recordedAt, timestampSource: input.timestampSource ?? "observer",
      recordedAt, clockId: input.clockId ?? "host-wall-clock", data: input.data ?? {},
    };
    assertEvent(event);
    try {
      const bytes = Buffer.from(JSON.stringify(event) + "\n");
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(this.fd, bytes, written, bytes.length - written);
        if (count === 0) throw new Error("Trace write made no progress");
        written += count;
      }
      fsyncSync(this.fd);
      this.seq++;
    } catch {
      try { this.close(); } catch { /* retain the original append failure */ }
      throw new CliError("Operation trace could not be appended; execution must stop", "TRACE_UNAVAILABLE");
    }
    return event;
  }
  reference() { return { id: this.operationId, commandId: this.commandId, path: this.path, inspect: `teams-cli trace ${this.operationId}` }; }
  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}

export interface TraceRead { events: TraceEvent[]; issues: string[]; incomplete: boolean }
/** Reads a possibly live/crashed file. Never truncates or repairs the original. */
export function readTrace(id: string, directory = traceDirectory()): TraceRead {
  let raw: string;
  try { raw = readFileSync(tracePath(id, directory), "utf8"); }
  catch (error) { if (error instanceof CliError) throw error; throw new CliError("Trace file could not be read", "TRACE_NOT_FOUND"); }
  const lines = raw.split("\n"); const events: TraceEvent[] = []; const issues: string[] = [];
  const incomplete = raw.length > 0 && !raw.endsWith("\n");
  if (incomplete) { lines.pop(); issues.push("Trailing record is incomplete; retained on disk and excluded from reconstruction"); }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try { const e: unknown = JSON.parse(lines[i]); assertEvent(e); events.push(e); }
    catch { issues.push(`Invalid record at line ${i + 1}`); }
  }
  if (events.some(e => e.operationId !== id)) issues.push("Operation identity differs from the requested trace file");
  issues.push(...validateRelations(events));
  return { events, issues, incomplete };
}

/** Validate by identities/append sequences, not the physical order of lines. */
export function validateRelations(events: TraceEvent[]): string[] {
  const issues: string[] = []; const byId = new Map<string, TraceEvent>(); const seqs = new Set<number>();
  const operation = events[0]?.operationId;
  for (const e of events) {
    if (byId.has(e.eventId)) issues.push(`Duplicate eventId ${e.eventId}`);
    if (seqs.has(e.seq)) issues.push(`Duplicate seq ${e.seq}`);
    if (e.operationId !== operation) issues.push(`Mixed operation at ${e.eventId}`);
    byId.set(e.eventId, e); seqs.add(e.seq);
  }
  for (const e of events) {
    for (const kind of ["refs", "causedBy", "supersedes"] as const) for (const id of e[kind] ?? []) {
      const prior = byId.get(id);
      if (!prior) { issues.push(`Unresolved ${kind} ${id} at ${e.eventId}`); continue; }
      if (id === e.eventId) issues.push(`Self-reference at ${e.eventId}`);
      if (kind === "supersedes" && (e.evidence !== "assessment" || prior.evidence !== "assessment" || !e.stepId || e.stepId !== prior.stepId || prior.seq >= e.seq || e.commandId !== prior.commandId))
        issues.push(`Invalid assessment supersession at ${e.eventId}`);
    }
    if (e.event.startsWith("step.") && e.event !== "step.started" && !events.some(p => p.stepId === e.stepId && p.commandId === e.commandId && p.event === "step.started" && p.seq < e.seq))
      issues.push(`Step event has no earlier start at ${e.eventId}`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { issues.push(`Causal cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id); for (const parent of byId.get(id)?.causedBy ?? []) if (byId.has(parent)) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return [...new Set(issues)];
}

export function reconstruct(events: TraceEvent[], atSeq = Infinity) {
  const known = events.filter(e => e.seq <= atSeq).sort((a, b) => a.seq - b.seq);
  const replaced = new Set(known.flatMap(e => e.supersedes ?? []));
  const steps = new Map<string, { commandId: string; stepId: string; action: unknown; outcome: unknown; evidence: string[] }>();
  for (const e of known) {
    if (!e.stepId) continue;
    if (e.event === "step.started") steps.set(e.stepId, { commandId: e.commandId, stepId: e.stepId, action: e.data.action, outcome: "unknown", evidence: [e.eventId] });
    const step = steps.get(e.stepId);
    if (step && e.evidence === "assessment" && !replaced.has(e.eventId) && e.data.outcome) {
      if (step.evidence.length > 1 && step.outcome !== e.data.outcome) step.outcome = "conflicting_assessments";
      else step.outcome = e.data.outcome;
      step.evidence.push(e.eventId);
    }
  }
  const activity: Array<{ seq: number; throughSeq: number; timestamp: string; throughTimestamp: string; clockId?: string; actor: Actor; event: string; target: unknown; overOverlay: boolean; repeats: number }> = [];
  let previousWasInput = false;
  for (const e of known) {
    if (e.event === "input.observed" || e.event.startsWith("control.")) {
      const previous = activity.at(-1), type = e.event === "input.observed" ? String(e.data.type) : e.event;
      const overOverlay = e.event.startsWith("control.") || !!e.data.overOverlay;
      if (e.event === "input.observed" && previousWasInput && previous && previous.actor === e.actor && previous.event === type && previous.clockId === e.clockId && previous.overOverlay === overOverlay && JSON.stringify(previous.target) === JSON.stringify(e.data.target)) {
        previous.repeats++; previous.throughSeq = e.seq; previous.throughTimestamp = e.timestamp;
      } else activity.push({ seq: e.seq, throughSeq: e.seq, timestamp: e.timestamp, throughTimestamp: e.timestamp, clockId: e.clockId, actor: e.actor, event: type, target: e.data.target ?? {}, overOverlay, repeats: 1 });
      previousWasInput = e.event === "input.observed";
    } else if (!["gate.deadline.reset", "gate.idle.reset", "gate.blocked", "notice.emitted"].includes(e.event)) previousWasInput = false;
  }
  const lastAction = known.filter(e => e.event === "agent.action.completed").at(-1);
  const lastConfirmedAction = lastAction ? { commandId: lastAction.commandId, seq: lastAction.seq, eventId: lastAction.eventId, stepId: lastAction.stepId, action: lastAction.data.action,
    meaning: "Last observed local action return; application verification is recorded separately" } : null;
  const commands = known.filter(e => e.event.startsWith("command.")).map(e => ({ commandId: e.commandId, seq: e.seq, event: e.event, ...e.data }));
  return { commands, lastConfirmedAction, order: "append sequence (known observation history); occurrence order across clocks may be indeterminate", steps: [...steps.values()], activity, outcomes: known.filter(e => e.event === "action.outcome").map(e => ({ seq: e.seq, eventId: e.eventId, ...e.data })) };
}

/** Bounded human/agent view. The journal and full reconstruction are never truncated. */
export function summarizeTrace(events: TraceEvent[], atSeq = Infinity) {
  const full = reconstruct(events, atSeq);
  return { ...full, commands: full.commands.slice(-20), steps: full.steps.slice(-20), activity: full.activity.slice(-12), outcomes: full.outcomes.slice(-12),
    omitted: { earlierCommandEvents: Math.max(0, full.commands.length - 20), earlierSteps: Math.max(0, full.steps.length - 20), earlierActivityGroups: Math.max(0, full.activity.length - 12), earlierOutcomes: Math.max(0, full.outcomes.length - 12) },
    summary: "Recent groups in append order; only consecutive identical inputs are grouped, ignoring their derived gate/notice records. Full individual events remain available with trace --raw." };
}
