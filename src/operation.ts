import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import type { Session } from "./cdp.js";
import { InteractionStop, isInteractionStop } from "./activity-gate.js";
import { TraceWriter, readTrace, summarizeTrace, type EventInput } from "./trace.js";
import { UiController } from "./ui-controller.js";

/** A session owns one journal and observer across independently completed commands. */
export class InteractionSession {
  readonly trace = new TraceWriter();
  ui?: UiController;
  notice = (line: string) => { process.stderr.write(line); };
  busy = false;
  ended = false;
  private closing?: Promise<void>;
  constructor() { this.trace.append({ actor: "system", component: "executor", event: "session.started", evidence: "observation" }); }
  async end(reason = "agent"): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.trace.append({ actor: reason === "agent" ? "agent" : "system", component: "executor", event: "session.end.requested", evidence: "intent", data: { reason } });
      this.ui?.gate.cancel();
    }
    if (!this.busy) await this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    this.closing = (async () => {
      await this.ui?.close();
      try { this.trace.append({ actor: "system", component: "executor", event: "session.ended", evidence: "observation" }); }
      finally { this.trace.close(); }
    })();
    return this.closing;
  }
}
interface Operation { trace: TraceWriter; ui?: UiController; owner?: InteractionSession; uiScope?: boolean }
const operations = new AsyncLocalStorage<Operation>();
export function currentOperation(): Operation | undefined { return operations.getStore(); }
export function recordOperationEvent(event: EventInput): void { operations.getStore()?.trace.append(event); }

/** Every Teams command has a trace, including commands that only read the local cache. */
export async function withOperation(command: string, action: () => Promise<unknown>, owner?: InteractionSession): Promise<Record<string, unknown>> {
  if (owner?.ended) throw new CliError("Interaction session has ended", "SESSION_ENDED");
  if (owner?.busy) throw new CliError("Another command is running in this session; no command was queued", "UI_BUSY");
  const trace = owner?.trace ?? new TraceWriter();
  if (owner) { owner.busy = true; trace.commandId = randomUUID(); }
  return operations.run({ trace, owner, ui: owner?.ui }, async () => {
    try {
      trace.append({ actor: "agent", component: "cli", event: "command.received", evidence: "intent", data: { command } });
      if (owner?.ui) {
        if (owner.ui.gate.state === "waiting") {
          owner.notice("Session is paused. Waiting for Resume, idle/countdown release or Cancel. This command will not execute when the wait ends.\n");
          trace.append({ actor: "system", component: "executor", event: "notice.emitted", evidence: "observation", data: { reason: "command-arrived-during-pause", pendingStepsWillExecute: false } });
          await owner.ui.waitForRelease();
        }
        await owner.ui.beginCommand();
      }
      const result = await action();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new CliError("Command must return a structured object", "OUTPUT_INVALID");
      trace.append({ actor: "system", component: "executor", event: "command.completed", evidence: "assessment", data: { outcome: "completed" } });
      const ref = trace.reference();
      return { ...result as Record<string, unknown>, trace: ref };
    } catch (error) {
      if (isInteractionStop(error)) {
        const cancelled = error.code === "COMMAND_CANCELLED";
        trace.append({ actor: "system", component: "executor", event: cancelled ? "command.cancelled" : "command.interrupted", evidence: "assessment", data: { outcome: cancelled ? "cancelled" : "interrupted", pendingStepsWillExecute: false } });
        process.exitCode = 1;
        return { status: cancelled ? "cancelled" : "interrupted", pendingStepsWillExecute: false,
          instruction: cancelled ? "Operation cancelled. Inspect the trace for any effects already dispatched. Do not retry automatically." : !owner ? "Pause released. Inspect the trace and current UI before issuing a fresh command; pending steps will not execute." : "Pause released. This command will not resume automatically. The session and view remain active. Review the trace and current UI state before issuing a fresh command in this session. End the session with teams-cli session end when the task is done. Do not replay blindly or treat this interruption as task completion.",
          progress: summarizeTrace(readTrace(trace.operationId).events),
          trace: trace.reference() };
      }
      try {
        trace.append({ actor: "system", component: "executor", event: "command.failed", evidence: "assessment", data: { code: error instanceof CliError ? error.code : "UNKNOWN", outcome: "failed" } });
      } catch (recordingError) { error = recordingError; }
      const suggestions = [`Trace: ${trace.path}`, `Inspect: teams-cli trace ${trace.operationId}`];
      const failure = error instanceof CliError
        ? new CliError(error.message, error.code, [...error.suggestions, ...suggestions])
        : new CliError("Command failed; inspect its operation trace", "COMMAND_FAILED", suggestions);
      failure.trace = trace.reference();
      throw failure;
    } finally {
      if (owner) {
        await owner.ui?.finishCommand(); owner.busy = false;
        if (owner.ended) await owner.close();
      } else trace.close();
    }
  });
}

const uiTarget = new WeakMap<UiController, string>();

/** UI owner lives inside the cross-process lock and remains held for the entire wait. */
export async function withUiControl<T>(session: Session, action: () => Promise<T>): Promise<T> {
  const operation = operations.getStore();
  if (!operation) return action(); // library tests/embedders may supply their own coordinator
  if (operation.uiScope) throw new CliError("Nested UI ownership is not supported", "UI_BUSY");
  let ui = operation.owner?.ui;
  if (ui && uiTarget.get(ui) !== session.target.webSocketDebuggerUrl) throw new CliError("This session owns a different page; end it before switching targets", "UI_BUSY");
  if (!ui) {
    ui = await UiController.open(session, operation.trace, operation.owner ? line => operation.owner!.notice(line) : undefined);
    uiTarget.set(ui, session.target.webSocketDebuggerUrl);
    if (operation.owner) {
      operation.owner.ui = ui;
      const owner = operation.owner;
      ui.onTerminated = () => { void owner.end("view-or-observer").catch(() => ui!.close()); };
    }
  }
  operation.ui = ui; operation.uiScope = true;
  try {
    ui.assertAllowed();
    const result = await action();
    ui.assertAllowed();
    return result;
  } catch (error) {
    if (ui.gate.interrupted || isInteractionStop(error)) {
      if (!ui.gate.interrupted) throw error;
      return await ui.waitForRelease();
    }
    throw error;
  } finally {
    operation.uiScope = false;
    if (!operation.owner) { await ui.close(); operation.ui = undefined; }
  }
}

/** No script source, command arguments, text or CDP payload is written to traces. */
export function instrumentSession(session: Session): Session {
  const step = async <T>(action: string, invoke: (stepId: string) => Promise<T>, method?: string, params?: Record<string, unknown>): Promise<T> => {
    const operation = operations.getStore();
    if (!operation) return invoke("");
    const { trace, ui } = operation; const stepId = randomUUID();
    const start = trace.append({ actor: "agent", component: "executor", event: "step.started", evidence: "intent", stepId, data: { action } });
    let dispatched = false, returned = false;
    try {
      if (ui) await ui.beforeStep(stepId, method, params);
      trace.append({ actor: "agent", component: "executor", event: "step.dispatch.requested", evidence: "intent", stepId, causedBy: [start.eventId], data: { action } });
      dispatched = true;
      const result = await invoke(stepId);
      returned = true;
      trace.append({ actor: "system", component: "executor", event: "step.completed", evidence: "assessment", stepId, refs: [start.eventId], data: { outcome: "completed", action, meaning: "The step returned successfully; delivery confirmation is a separate event" } });
      if (ui) await ui.afterStep();
      return result;
    } catch (error) {
      // Interruption after a successful return must not replace its confirmed execution.
      if (returned && isInteractionStop(error)) {
        trace.append({ actor: "system", component: "executor", event: "step.interrupted", evidence: "observation", stepId, refs: [start.eventId], data: { pendingStepsWillExecute: false } });
      } else {
        trace.append({ actor: "system", component: "executor", event: dispatched ? "step.outcome.unknown" : "step.not.executed", evidence: "assessment", stepId, refs: [start.eventId],
          ...(dispatched ? { uncertainty: { reason: "The dispatched step did not provide a successful result; partial effects remain possible", needs: ["Inspect current Teams state and any observed response"] } } : {}),
          data: { outcome: dispatched ? "unknown" : "not_executed", action, code: error instanceof CliError ? error.code : "UNKNOWN" } });
      }
      throw error;
    }
  };
  return {
    target: session.target,
    run: <T>(source: string, timeoutMs?: number, label?: string) => step<T>(label ?? /\/\*axi:([A-Z_]+)\*\/$/.exec(source)?.[1].toLowerCase().replaceAll("_", ".") ?? "page.evaluate", async stepId => {
      const ui = operations.getStore()?.ui;
      const expression = ui ? `(() => { const g=globalThis.__teamsCliGate; if(!g || g.operationId!==${JSON.stringify(ui.trace.operationId)}) throw Error('TEAMS_CLI:ACTIVITY_OBSERVATION_LOST:Activity gate is missing'); g.beginStep(${JSON.stringify(stepId)},${JSON.stringify(ui.trace.commandId)}); return (${source}); })()` : source;
      return session.run<T>(expression, timeoutMs);
    }),
    cdp: (method, params = {}, timeoutMs) => step(method, () => {
      const ui = operations.getStore()?.ui;
      return ui && method.startsWith("Input.") ? ui.dispatchInput(method, params, timeoutMs) : session.cdp(method, params, timeoutMs);
    }, method, params),
  };
}
