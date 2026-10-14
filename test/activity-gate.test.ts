import { expect, it } from "vitest";
import { ActivityGate } from "../src/activity-gate.js";
import type { EventInput, TraceEvent } from "../src/trace.js";
function fixture() {
  let clock = 0; const notices: string[] = [], events: EventInput[] = [];
  const gate = new ActivityGate(e => { events.push(e); return { ...e, eventId: `event-${events.length}` } as TraceEvent; }, n => notices.push(n), () => clock);
  return { gate, notices, events, advance(ms: number) { clock += ms; }, tick(ms = 0) { clock += ms; gate.tick(); } };
}
it("records input without entering pause, including focus and movement inside/outside the view", () => {
  const f = fixture();
  for (const type of ["pointermove", "pointerdown", "click", "input", "keydown", "wheel", "scroll", "focus", "blur", "visibilitychange"]) {
    for (const overOverlay of [true, false]) f.gate.activity({ type, overOverlay });
  }
  f.tick(100000);
  expect(f.gate.state).toBe("open"); expect(() => f.gate.assertAllowed()).not.toThrow();
  expect(f.notices).toHaveLength(0); expect(f.events).toHaveLength(20);
  expect(f.events.every(e => e.event === "input.observed" && e.actor === "unknown")).toBe(true);
});
it("uses 30s idle then a separate 10s countdown, and never reauthorizes the interrupted command", () => {
  const f = fixture(); f.gate.pause("pause-id"); f.tick(29999);
  expect(f.gate.idleTimeMs).toBe(29999); expect(f.gate.countdownRemainingMs).toBeNull();
  f.tick(1); expect(f.gate.phase).toBe("countdown"); expect(f.gate.idleTimeMs).toBeNull(); expect(f.gate.countdownRemainingMs).toBe(10000);
  f.tick(9999); expect(f.gate.state).toBe("waiting"); expect(f.gate.countdownRemainingMs).toBe(1);
  f.tick(1); expect(f.gate.state).toBe("released"); expect(f.gate.releaseReason).toBe("countdown");
  expect(() => f.gate.assertAllowed()).toThrow("paused");
  expect(f.notices).toHaveLength(1); expect(f.notices[0]).toContain("Pending steps will not execute");
  f.gate.beginCommand(); expect(() => f.gate.assertAllowed()).not.toThrow();
});
it("delayed ticks still give a full countdown and source timestamps cannot backdate inactivity", () => {
  const f = fixture(); f.gate.pause(); f.tick(90000);
  expect(f.gate.countdownRemainingMs).toBe(10000);
  f.gate.activity({ type: "input", timestamp: "2000-01-01T00:00:00.000Z" });
  expect(f.gate.phase).toBe("idle"); expect(f.gate.idleTimeMs).toBe(0);
  f.tick(30000); expect(f.gate.countdownRemainingMs).toBe(10000);
});
it.each(["pointermove", "input", "keydown", "wheel", "touchmove", "touchend"])("%s resets idle and cancels a running countdown", type => {
  const f = fixture(); f.gate.pause(); f.tick(30000); f.tick(5000);
  f.gate.activity({ type });
  expect(f.gate.phase).toBe("idle"); expect(f.gate.countdownRemainingMs).toBeNull(); expect(f.gate.idleTimeMs).toBe(0);
  f.tick(29999); expect(f.gate.phase).toBe("idle"); f.tick(1); expect(f.gate.countdownRemainingMs).toBe(10000);
  expect(f.events.find(e => e.event === "gate.idle.reset")?.data?.cancelledCountdown).toBe(true);
});
it("focus/visibility and duplicate Pause do not reset idle or countdown", () => {
  const f = fixture(); f.gate.pause(); f.tick(15000); f.gate.pause();
  for (const type of ["focus", "blur", "visibilitychange"]) f.gate.activity({ type });
  f.tick(15000); expect(f.gate.phase).toBe("countdown");
  f.gate.activity({ type: "focus" }); f.tick(10000); expect(f.gate.state).toBe("released");
});
it.each([100, 35000])("manual Resume releases either phase (%s), preserving the latch", time => {
  const f = fixture(); f.gate.resume(); expect(f.gate.state).toBe("open");
  f.gate.pause(); f.tick(time); f.gate.resume("resume-id"); f.tick(1000);
  expect(f.gate.releaseReason).toBe("resume"); expect(f.gate.totalWaitMs).toBe(time);
  expect(() => f.gate.assertAllowed()).toThrow("paused");
  expect(f.events.find(e => e.event === "gate.released")?.causedBy).toEqual(["resume-id"]);
  f.gate.pause(); expect(f.gate.state).toBe("waiting");
});
it.each([false, true])("Cancel is terminal with or without Pause (%s)", paused => {
  const f = fixture(); if (paused) f.gate.pause(); f.gate.cancel("cancel-id"); f.gate.resume(); f.gate.pause(); f.tick(100000);
  expect(f.gate.state).toBe("cancelled"); expect(() => f.gate.assertAllowed()).toThrow("cancelled"); expect(() => f.gate.beginCommand()).toThrow("cancelled");
});
