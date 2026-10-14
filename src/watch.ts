import type { EventKind, Observation, ObservedEvent } from "./observation.js";

/** Consume buffered arrivals before checking the deadline, including the final wake. */
export async function collectEvents(observation: Observation, options: {
  timeoutMs: number; limit: number; kind?: EventKind; conversationId?: string;
}, now = Date.now): Promise<ObservedEvent[]> {
  const deadline = now() + options.timeoutMs;
  const collected: ObservedEvent[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (;;) {
    const events = observation.snapshot();
    for (const e of events.slice(cursor)) {
      if (!["message", "typing", "presence", "call"].includes(e.kind) ||
          (options.kind && e.kind !== options.kind) ||
          (options.conversationId && e.conversationId !== options.conversationId)) continue;
      // Arrival time is the fallback only when the source supplies no version/id.
      const id = JSON.stringify([e.kind, e.conversationId, e.messageId, e.version || e.callId || e.at, e.senderId, e.state, e.change]);
      if (seen.has(id)) continue;
      seen.add(id); collected.push(e);
      if (collected.length >= options.limit) return collected;
    }
    cursor = events.length;
    const remaining = deadline - now();
    if (remaining <= 0) return collected;
    await observation.wait(Math.min(500, remaining));
  }
}
