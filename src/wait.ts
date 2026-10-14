import { script, type Session } from "./cdp.js";
import type { RawMessage } from "./model.js";
import { LIST_MESSAGES } from "./page/scripts.js";
import { getMessage } from "./edit.js";
import type { Observation } from "./observation.js";

export interface WaitDeps {
  session: Session;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Already armed before the baseline below. Owned and closed by the caller. */
  observation?: Observation;
}

export interface WaitInput {
  conversationId: string;
  timeoutMs: number;
  /** Only accept messages whose sender name contains this (case-insensitive). */
  from?: string;
}

type Listing = { messages: RawMessage[] };

/**
 * Wait for a new message from someone else using the local cache and an already
 * armed observation. Buffered NewMessage events survive the
 * baseline read. Cache-only polling remains available to embedded callers and tests.
 */
export async function waitForMessage(input: WaitInput, deps: WaitDeps): Promise<RawMessage | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const poll = deps.pollMs ?? 500;
  deps.observation?.assertHealthy();
  const deadline = now() + input.timeoutMs;
  const list = () => deps.session.run<Listing>(script(LIST_MESSAGES, { conversationId: input.conversationId, want: 20, maxChains: 80 }));
  const seen = new Set((await list()).messages.map((m) => m.id));
  const consumedEvents = new Set<string>();
  const from = input.from?.toLowerCase();
  while (now() < deadline) {
    deps.observation?.assertHealthy();
    const arrivals = deps.observation?.snapshot().filter((e) => e.kind === "message" && e.change === "NewMessage" && e.conversationId === input.conversationId && e.messageId && !consumedEvents.has(e.messageId)) ?? [];
    const fresh = new Map<string, RawMessage>();
    // The direct id lookup also covers a burst larger than the latest-message window.
    for (const event of arrivals) {
      if (consumedEvents.has(event.messageId!)) continue;
      const m = await getMessage(deps.session, input.conversationId, event.messageId!);
      if (m) {
        fresh.set(m.id, m);
        consumedEvents.add(m.id);
      }
    }
    for (const m of (await list()).messages) if (!seen.has(m.id)) fresh.set(m.id, m);
    for (const id of fresh.keys()) seen.add(id);
    const hit = [...fresh.values()]
      .filter((m) => !m.fromMe && /^[1-9]\d*$/.test(m.id) && (!from || (m.fromName ?? "").toLowerCase().includes(from)))
      .sort((a, b) => a.time - b.time)[0];
    if (hit) return hit;
    const remaining = Math.min(poll, Math.max(0, deadline - now()));
    if (deps.observation) await deps.observation.wait(remaining);
    else await sleep(remaining);
  }
  return null;
}
