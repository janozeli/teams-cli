import { CliError } from "./errors.js";
import type { EventInput, TraceEvent } from "./trace.js";

export const VIEW_REFRESH_MS = 250;
export const IDLE_BEFORE_COUNTDOWN_MS = 30_000;
export const RESUME_COUNTDOWN_MS = 10_000;
export const RESET_IDLE_INPUTS = new Set(["pointermove", "pointerdown", "pointerup", "click", "keydown", "keyup", "beforeinput", "input", "wheel", "scroll", "touchstart", "touchmove", "touchend"]);

export class InteractionStop extends CliError {
  constructor(public readonly cancelled = false) {
    super(cancelled ? "Operation cancelled; pending steps were not executed" : "Operation paused; pending steps will not execute after release", cancelled ? "COMMAND_CANCELLED" : "COMMAND_INTERRUPTED");
  }
}
export const isInteractionStop = (error: unknown): error is InteractionStop => error instanceof InteractionStop ||
  (error instanceof CliError && ["COMMAND_INTERRUPTED", "COMMAND_CANCELLED"].includes(error.code));

/** Pause enters the barrier. Idle/countdown release never reauthorizes an old command. */
export class ActivityGate {
  state: "open" | "waiting" | "released" | "cancelled" = "open";
  phase: "idle" | "countdown" | null = null;
  interrupted = false;
  waitStartedAt?: number;
  waitEndedAt?: number;
  lastInteractionAt?: number;
  countdownStartedAt?: number;
  releaseReason?: "resume" | "countdown";
  private blockedId?: string;
  constructor(
    private append: (input: EventInput) => TraceEvent,
    private notice: (line: string) => void,
    private now = () => performance.now(),
  ) {}
  activity(input: { type: string; target?: Record<string, string>; actor?: "user" | "unknown"; timestamp?: string; clockId?: string; overOverlay?: boolean }): void {
    if (this.state === "cancelled") return;
    const event = this.append({ actor: input.actor ?? "unknown", component: "ui", event: "input.observed", evidence: "observation",
      ...(input.timestamp ? { timestamp: input.timestamp, timestampSource: "source" as const, clockId: input.clockId } : {}),
      uncertainty: input.actor === "user" ? undefined : { reason: "Uncorrelated DOM input; human and external automation cannot be distinguished from isTrusted alone" },
      data: { type: input.type, target: input.target ?? {}, overOverlay: !!input.overOverlay },
    });
    if (this.state !== "waiting" || !RESET_IDLE_INPUTS.has(input.type)) return;
    const cancelledCountdown = this.phase === "countdown";
    this.lastInteractionAt = this.now(); this.countdownStartedAt = undefined; this.phase = "idle";
    this.append({ actor: "system", component: "activity-gate", event: "gate.idle.reset", evidence: "observation", causedBy: [event.eventId],
      data: { cancelledCountdown, idleBeforeCountdownMs: IDLE_BEFORE_COUNTDOWN_MS } });
  }
  pause(controlId?: string): void {
    if (this.state !== "open" && this.state !== "released") return;
    this.interrupted = true; this.state = "waiting"; this.phase = "idle";
    this.waitStartedAt = this.lastInteractionAt = this.now(); this.waitEndedAt = this.countdownStartedAt = undefined; this.releaseReason = undefined;
    this.blockedId = this.append({ actor: "system", component: "activity-gate", event: "gate.blocked", evidence: "observation",
      causedBy: controlId ? [controlId] : [], data: { reason: "pause", pendingStepsWillExecute: false, idleBeforeCountdownMs: IDLE_BEFORE_COUNTDOWN_MS, resumeCountdownMs: RESUME_COUNTDOWN_MS } }).eventId;
    this.notice("Paused. After 30s without interaction, the view will show a 10s resume countdown. Resume releases early; Cancel ends the session. Pending steps will not execute when this wait ends.\n");
    this.append({ actor: "system", component: "activity-gate", event: "notice.emitted", evidence: "observation", causedBy: [this.blockedId], data: { reason: "pause" } });
  }
  tick(): void {
    if (this.state !== "waiting") return;
    if (this.phase === "idle" && this.now() - this.lastInteractionAt! >= IDLE_BEFORE_COUNTDOWN_MS) {
      // A delayed observer starts a full visible countdown, never consumes it retroactively.
      this.phase = "countdown"; this.countdownStartedAt = this.now();
      this.append({ actor: "system", component: "activity-gate", event: "gate.countdown.started", evidence: "observation", refs: this.blockedId ? [this.blockedId] : [], data: { resumeCountdownMs: RESUME_COUNTDOWN_MS } });
    } else if (this.phase === "countdown" && this.countdownRemainingMs === 0) this.release("countdown");
  }
  get idleTimeMs(): number | null { return this.state === "waiting" && this.phase === "idle" ? this.now() - this.lastInteractionAt! : null; }
  get countdownRemainingMs(): number | null { return this.state === "waiting" && this.phase === "countdown" ? Math.max(0, RESUME_COUNTDOWN_MS - (this.now() - this.countdownStartedAt!)) : null; }
  get totalWaitMs(): number { return this.waitStartedAt === undefined ? 0 : (this.waitEndedAt ?? this.now()) - this.waitStartedAt; }
  assertAllowed(): void { if (this.interrupted) throw new InteractionStop(this.state === "cancelled"); }
  /** Only a fresh command may clear the interruption latch. */
  beginCommand(): void {
    if (this.state === "waiting" || this.state === "cancelled") throw new InteractionStop(this.state === "cancelled");
    this.state = "open"; this.interrupted = false;
  }
  resume(controlId?: string): void { this.release("resume", controlId); }
  private release(reason: "resume" | "countdown", controlId?: string): void {
    if (this.state !== "waiting") return;
    this.state = "released"; this.phase = null; this.waitEndedAt = this.now(); this.releaseReason = reason;
    this.append({ actor: "system", component: "activity-gate", event: "gate.released", evidence: "observation",
      refs: this.blockedId ? [this.blockedId] : [], causedBy: controlId ? [controlId] : [],
      data: { reason, totalWaitMs: this.totalWaitMs, pendingStepsWillExecute: false } });
  }
  cancel(controlId?: string): void {
    if (this.state === "cancelled") return;
    this.state = "cancelled"; this.phase = null; this.interrupted = true; this.waitEndedAt = this.now();
    this.append({ actor: "system", component: "activity-gate", event: "gate.cancelled", evidence: "observation",
      causedBy: controlId ? [controlId] : [], data: { totalWaitMs: this.totalWaitMs, pendingStepsWillExecute: false } });
  }
}
