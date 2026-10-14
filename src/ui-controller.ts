import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import { ActivityGate, InteractionStop, VIEW_REFRESH_MS } from "./activity-gate.js";
import { Connection, type ProtocolEvent } from "./connection.js";
import { pageError, type Session } from "./cdp.js";
import { INSTALL_ACTIVITY_VIEW } from "./page/activity-view.js";
import type { TraceWriter } from "./trace.js";

/** One UI owner, one live gate, all related document contexts. Pure reads need no view. */
export class UiController {
  readonly gate: ActivityGate;
  private readonly binding = "__teamsCli_" + randomUUID().replaceAll("-", "");
  private ackControls: Record<string, number> = {};
  private commandRevision = 1;
  private commandActive = true;
  onTerminated?: () => void;
  private contexts = new Map<string, { contextId: number; sid?: string }>();
  private sessions = new Set<string>();
  private setups = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private tickDone?: Promise<void>;
  private closing = false;
  private failure?: Error;
  private unsub: () => void;
  private unsubClose: () => void;
  private waiters = new Set<() => void>();
  private newDocumentScripts = new Map<string, string>();
  private constructor(private connection: Connection, readonly trace: TraceWriter, notice: (line: string) => void) {
    this.gate = new ActivityGate(e => trace.append(e), notice);
    this.unsub = connection.onEvent(e => this.receive(e));
    this.unsubClose = connection.onClose(() => this.fail(new CliError("Activity observation connection was lost; no further steps may execute", "ACTIVITY_OBSERVATION_LOST")));
  }
  static async open(session: Session, trace: TraceWriter, notice = (line: string) => { process.stderr.write(line); }): Promise<UiController> {
    const controller = new UiController(await Connection.open(session.target.webSocketDebuggerUrl), trace, notice);
    try {
      await controller.arm();
      while (controller.setups.size) await Promise.all([...controller.setups]);
      controller.assertHealthy();
      if (!controller.contexts.size) throw new CliError("Could not observe a Teams document", "ACTIVITY_OBSERVATION_LOST");
      trace.append({ actor: "system", component: "activity-gate", event: "observer.armed", evidence: "observation", data: { documents: controller.contexts.size } });
      controller.timer = setInterval(() => { void controller.tick(); }, VIEW_REFRESH_MS);
      return controller;
    } catch (error) { await controller.close(); throw error; }
  }
  private expression(sid?: string): string {
    const config = JSON.stringify({ operationId: this.trace.operationId, binding: this.binding, ...this.viewState() });
    return `(${INSTALL_ACTIVITY_VIEW})({...${config},view:${!sid} && globalThis === globalThis.top})`;
  }
  private async arm(sid?: string): Promise<void> {
    await this.connection.call("Runtime.addBinding", { name: this.binding }, sid);
    // Existing contexts arrive during enable; future documents are also instrumented before app scripts.
    try {
      const { identifier } = await this.connection.call("Page.addScriptToEvaluateOnNewDocument", { source: this.expression(sid) }, sid);
      if (identifier) this.newDocumentScripts.set(sid ?? "page", identifier);
    } catch { /* Workers have no Page domain and no user-facing document. */ }
    await this.connection.call("Runtime.enable", {}, sid);
    await this.connection.call("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true }, sid);
  }
  private track(promise: Promise<void>): void {
    this.setups.add(promise);
    void promise.catch(error => this.fail(error instanceof Error ? error : new Error("Could not arm document observation")))
      .finally(() => this.setups.delete(promise));
  }
  private receive(e: ProtocolEvent): void {
    if (this.closing) return;
    const p = e.params;
    if (e.method === "Target.attachedToTarget") {
      const sid: string = p.sessionId; this.sessions.add(sid);
      this.track((async () => {
        try { await this.arm(sid); }
        finally { await this.connection.call("Runtime.runIfWaitingForDebugger", {}, sid); }
      })());
    } else if (e.method === "Runtime.executionContextCreated" && p.context?.auxData?.isDefault) {
      const contextId = p.context.id, sid = e.sessionId;
      const key = `${sid ?? "page"}:${contextId}`;
      this.contexts.set(key, { contextId, sid });
      this.track((async () => {
        try {
          const result = await this.connection.call("Runtime.evaluate", { expression: this.expression(sid), contextId, returnByValue: true }, sid);
          if (result.exceptionDetails) throw pageError(result.exceptionDetails);
        } catch (error) { if (this.contexts.has(key)) throw error; }
      })());
    } else if (e.method === "Runtime.executionContextDestroyed") {
      this.contexts.delete(`${e.sessionId ?? "page"}:${p.executionContextId}`);
    } else if (e.method === "Runtime.executionContextsCleared") {
      for (const [key, c] of this.contexts) if (c.sid === e.sessionId) this.contexts.delete(key);
    } else if (e.method === "Target.detachedFromTarget") {
      this.sessions.delete(p.sessionId);
      for (const [key, c] of this.contexts) if (c.sid === p.sessionId) this.contexts.delete(key);
      this.trace.append({ actor: "application", component: "cdp", event: "document.detached", evidence: "observation", data: {} });
    } else if (e.method === "Runtime.bindingCalled" && p.name === this.binding) {
      if (typeof p.payload !== "string" || p.payload.length > 5000) { this.fail(new CliError("Activity observation exceeded its record limit", "ACTIVITY_OBSERVATION_LOST")); return; }
      const data = JSON.parse(p.payload);
      if (data.operationId !== this.trace.operationId) return;
      if (typeof data.clockId === "string" && Number.isSafeInteger(data.controlSeq)) this.ackControls[data.clockId] = Math.max(this.ackControls[data.clockId] ?? 0, data.controlSeq);
      // The page binding deliberately sends only generic event metadata, never input values.
      if (data.kind === "input") this.gate.activity({ type: data.type, target: data.target, overOverlay: data.overOverlay, timestamp: data.timestamp, clockId: data.clockId });
      else if (["control.pause", "control.resume", "control.cancel"].includes(data.kind)) {
        const control = this.trace.append({ actor: "unknown", component: "ui", event: data.kind, evidence: "observation", timestamp: data.timestamp, timestampSource: "source", clockId: data.clockId,
          uncertainty: { reason: "View control activation observed; human versus external automation is not established" }, data: {} });
        if (data.kind === "control.pause") this.gate.pause(control.eventId);
        else if (data.kind === "control.resume") this.gate.resume(control.eventId);
        else { this.gate.cancel(control.eventId); this.onTerminated?.(); }
        void this.tick();
      } else if (data.kind === "observer.lease.expired") this.fail(new CliError("Activity view lost its executor lease", "ACTIVITY_OBSERVATION_LOST"));
      else if (["agent.action.started", "agent.action.completed", "agent.input.correlated"].includes(data.kind))
        this.trace.append({ actor: "agent", component: "ui", event: data.kind, evidence: data.kind === "agent.input.correlated" ? "assessment" : "observation",
          ...(data.stepId ? { stepId: data.stepId } : {}), timestamp: data.timestamp, timestampSource: "source", clockId: data.clockId,
          ...(data.correlation === "expected-cdp-input" ? { uncertainty: { reason: "Input matches the executor's pending CDP dispatch; a concurrent identical external input cannot be distinguished" } } : {}),
          data: { action: data.action, type: data.type, target: data.target, correlation: data.correlation } });
      this.wake();
    }
  }
  private fail(error: Error): void { this.failure ??= error; this.wake(); this.onTerminated?.(); }
  private wake(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  assertHealthy(): void { if (this.failure) throw this.failure; if (this.closing) throw new CliError("Activity controller is closed", "ACTIVITY_OBSERVATION_LOST"); }
  assertAllowed(): void { this.assertHealthy(); this.gate.assertAllowed(); }
  async beforeStep(stepId: string, method?: string, params?: Record<string, unknown>): Promise<void> {
    this.assertAllowed();
    const expression = `(() => { const g=globalThis.__teamsCliGate; if(!g || g.operationId!==${JSON.stringify(this.trace.operationId)}) throw Error('TEAMS_CLI:ACTIVITY_OBSERVATION_LOST:Activity gate is missing'); g.update(${JSON.stringify(this.viewState())}); g.beginStep(${JSON.stringify(stepId)},${JSON.stringify(this.trace.commandId)}); ${method?.startsWith("Input.") ? `g.expectInput(${JSON.stringify(method)},${JSON.stringify(params ?? {})});` : ""} return true; })()`;
    const result = await this.connection.call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw pageError(result.exceptionDetails);
    this.assertAllowed();
  }
  /** Reuse the already armed socket; no new-WebSocket delay between authorization and input dispatch. */
  dispatchInput(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    this.assertAllowed();
    return this.connection.call(method, params, undefined, timeoutMs);
  }
  async afterStep(): Promise<void> {
    this.assertHealthy();
    const result = await this.connection.call("Runtime.evaluate", { expression: "globalThis.__teamsCliGate?.clearExpected()" });
    if (result.exceptionDetails) throw pageError(result.exceptionDetails);
    this.gate.assertAllowed();
  }
  private viewState() {
    return { state: this.gate.state, interrupted: this.gate.interrupted, phase: this.gate.phase,
      countdownRemainingMs: this.gate.countdownRemainingMs, commandId: this.trace.commandId,
      commandRevision: this.commandRevision, commandActive: this.commandActive, ackControls: this.ackControls };
  }
  async beginCommand(): Promise<void> {
    this.assertHealthy(); this.gate.beginCommand(); this.commandRevision++; this.commandActive = true;
    // beforeStep also pushes the current command state, independent of refresh cadence.
    await this.tickDone; await this.tick();
  }
  async finishCommand(): Promise<void> {
    this.commandActive = false; this.commandRevision++;
    await this.tickDone; await this.tick();
  }
  private tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.tickDone) return this.tickDone;
    this.tickDone = this.refresh().finally(() => { this.tickDone = undefined; this.wake(); });
    return this.tickDone;
  }
  private async refresh(): Promise<void> {
    try {
      this.gate.tick();
      const state = this.viewState();
      await Promise.all([...this.contexts].map(async ([key, c]) => {
        try { await this.connection.call("Runtime.evaluate", { expression: `globalThis.__teamsCliGate?.update(${JSON.stringify(state)})`, contextId: c.contextId }, c.sid); }
        catch (error) { if (this.contexts.has(key)) throw error; }
      }));
    } catch (error) { this.fail(error as Error); }
  }
  async waitForRelease(): Promise<never> {
    while (this.gate.state === "waiting") {
      this.assertHealthy();
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, VIEW_REFRESH_MS); this.waiters.add(done);
      });
    }
    this.assertHealthy();
    throw new InteractionStop(this.gate.state === "cancelled");
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true; clearInterval(this.timer); this.unsub(); this.unsubClose();
    await Promise.allSettled([...this.setups]);
    await Promise.allSettled([...this.contexts.values()].map(c => this.connection.call("Runtime.evaluate", { expression: `if(globalThis.__teamsCliGate?.operationId===${JSON.stringify(this.trace.operationId)}) globalThis.__teamsCliGate.close()`, contextId: c.contextId }, c.sid)));
    await Promise.allSettled([...this.newDocumentScripts].map(([sid, identifier]) => this.connection.call("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sid === "page" ? undefined : sid)));
    await Promise.allSettled([undefined, ...this.sessions].map(sid => this.connection.call("Runtime.removeBinding", { name: this.binding }, sid)));
    this.connection.close(); this.wake();
  }
}
