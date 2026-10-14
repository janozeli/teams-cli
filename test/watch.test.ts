import { expect, it } from "vitest";
import { collectEvents } from "../src/watch.js";
import type { Observation, ObservedEvent } from "../src/observation.js";
function fixture(initial: ObservedEvent[], next: ObservedEvent[]) {
  let clock = 0; const events = [...initial];
  const o: Observation = { snapshot: () => events.slice(), assertHealthy: () => {}, close: async () => {}, wait: async (ms) => { clock += ms; events.push(...next.splice(0)); } };
  return { o, now: () => clock };
}
it("retains events on the last wake and deduplicates burst copies by source identity", async () => {
  const call: ObservedEvent = { kind: "call", at: 1, callId: "one", state: "incoming" };
  const f = fixture([call], [{ ...call, at: 2 }, { ...call, callId: "two", at: 3 }]);
  expect((await collectEvents(f.o, { timeoutMs: 10, limit: 10 }, f.now)).map(e => e.callId)).toEqual(["one", "two"]);
});
it("preserves recurring presence states and typing pulses with new versions", async () => {
  const presence: ObservedEvent = { kind: "presence", at: 1, senderId: "8:user", state: "Available", version: "1" };
  const f = fixture([presence], [{ ...presence, state: "Busy", version: "2" }, { ...presence, version: "3" }]);
  expect(await collectEvents(f.o, { timeoutMs: 10, limit: 10 }, f.now)).toHaveLength(3);
});
it("enforces the selected kind, conversation and limit during a burst", async () => {
  const f = fixture(Array.from({ length: 25 }, (_, i): ObservedEvent => ({ kind: i % 2 ? "typing" : "message", at: i, conversationId: "48:notes" })), []);
  expect(await collectEvents(f.o, { timeoutMs: 10, limit: 3, kind: "typing", conversationId: "48:notes" }, f.now)).toHaveLength(3);
});
