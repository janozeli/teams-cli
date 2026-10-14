import { isInteractionStop } from "./activity-gate.js";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import { PageError, script, type Session } from "./cdp.js";
import { messageText } from "./format.js";
import { isDelivered, type Conversation, type RawMessage } from "./model.js";
import { openTarget, type Target } from "./navigate.js";
import { CLICK_SEND, COMPOSE, LIST_MESSAGES } from "./page/scripts.js";
import type { Observation } from "./observation.js";

export interface SendDeps {
  session: Session;
  audit: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to look for the sent message in the cache after clicking. */
  verifyMs?: number;
  observation?: Observation;
}

export interface SendInput {
  conv: Conversation;
  /** Defaults to a chat message. */
  target?: Target;
  html: string;
  /** Plain-text rendering of `html`, used to recognise the message once sent. */
  text: string;
}

export type SendResult = { status: "sent"; message: RawMessage; warnings: string[] };

type Listing = { totalChains: number; hasMore: boolean; messages: RawMessage[] };

const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is this cached message the one we sent, acknowledged by the server? Teams rewrites HTML (link
 * titles, entities), so compare the complete normalized plain text. A shared prefix is not delivery proof.
 */
export function isOurMessage(m: RawMessage, expected: string, notBefore: number, target: Target = { kind: "chat" }): boolean {
  if (!m.fromMe || m.time < notBefore || !isDelivered(m)) return false;
  // Channel messages must land in the right place: a new thread, or the chosen thread.
  if (target.kind === "post" && !m.isRoot) return false;
  if (target.kind === "reply" && (m.isRoot || m.chainId !== target.rootId)) return false;
  const got = squash(messageText({ ...m, files: [] })); // files are checked separately
  const want = squash(expected);
  if (!want) return false;
  return got === want;
}

/**
 * Open the chat, paste, click send, then confirm in the cache.
 *
 * Phases matter for retries: anything that fails before the click is `failed`
 * (nothing was sent, safe to retry). After the click we never claim failure:
 * the cache decides between `sent` and `SEND_UNVERIFIED` (do not blindly retry).
 */
export async function sendMessage(input: SendInput, deps: SendDeps): Promise<SendResult> {
  const { session, audit } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const verifyMs = deps.verifyMs ?? 15_000;
  const id = input.conv.id;
  const target: Target = input.target ?? { kind: "chat" };
  const where = { ...target, conversationId: id };
  const attempt = randomUUID();
  const base = { action: "send", attempt, chat: { title: input.conv.title, kind: input.conv.kind, id }, target };
  const list = (want: number) => session.run<Listing>(script(LIST_MESSAGES, { conversationId: id, want, maxChains: want * 4 }));

  audit({ ...base, phase: "attempt", html: input.html });
  let seen: Set<string>;
  try {
    seen = new Set((await list(30)).messages.map((m) => m.id));
    await openTarget(session, input.conv, target);
    await session.run(script(COMPOSE, { target: where, html: input.html, text: input.text }));
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    audit({ ...base, status: "failed", error: String((error as Error).message ?? error) });
    throw error;
  }

  // Server timestamps can lag or lead the local clock; allow generous skew.
  const notBefore = now() - 120_000;
  try {
    deps.observation?.assertHealthy();
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    audit({ ...base, status: "failed", note: "observation lost before click; draft left in composer" });
    throw error;
  }
  try {
    await session.run(script(CLICK_SEND, { target: where }));
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    // A coded page error is raised before the click, so nothing was sent.
    if (error instanceof PageError) {
      audit({ ...base, status: "failed", error: error.message, note: "draft left in the composer" });
      throw new CliError(`${error.message}; your text is still in the Teams composer`, error.code, [
        "Clear the draft in Teams before retrying",
      ]);
    }
    // Transport failure: the click may or may not have happened. Let the cache decide.
  }

  let found: RawMessage | undefined;
  let lastError: unknown;
  const deadline = now() + verifyMs;
  while (!found && now() < deadline) {
    await sleep(500);
    try {
      const acknowledgements = deps.observation?.snapshot().filter((e) => e.kind === "send-ack" && e.conversationId === id && e.status === 201);
      found = (await list(30)).messages.find((m) => !seen.has(m.id) && isOurMessage(m, input.text, notBefore, target)
        && (!acknowledgements || acknowledgements.some((e) => e.messageId === m.id && !!e.clientMessageId && e.clientMessageId === m.clientMessageId)));
    } catch (error) {
    if (isInteractionStop(error)) throw error;
      lastError = error;
    }
  }
  if (!found) {
    audit({ ...base, status: "unverified", error: lastError ? String((lastError as Error).message) : undefined });
    throw new CliError(`Could not confirm the message in the chat within ${Math.round(verifyMs / 1000)}s; it may or may not have been sent`, "SEND_UNVERIFIED", [
      "Check with `teams-cli read <chat> --limit 3` before retrying (retrying may duplicate it)",
    ]);
  }
  // Attachment chips outside the editor are detected heuristically before sending;
  // the delivered message is the ground truth, so report anything we did not ask for.
  const warnings = found.files.length ? [`The sent message carries file(s) that were not part of this send: ${found.files.join(", ")}`] : [];
  audit({ ...base, status: "sent", messageId: found.id, confirmation: deps.observation ? "response+cache" : "cache", ...(warnings.length ? { warnings } : {}) });
  return { status: "sent", message: found, warnings };
}
