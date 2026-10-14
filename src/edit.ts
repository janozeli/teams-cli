import { isInteractionStop } from "./activity-gate.js";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import { PageError, script, type Session } from "./cdp.js";
import { messageText } from "./format.js";
import type { Conversation, RawMessage } from "./model.js";
import { openConversation } from "./navigate.js";
import { EDIT_BOUND, EDIT_BUTTON, EDIT_CANCEL, EDIT_CLEARED, EDIT_LOCATE, EDIT_PASTE, EDIT_SAVE, GET_MESSAGE } from "./page/scripts.js";

export interface EditDeps {
  session: Session;
  audit: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  verifyMs?: number;
}

export interface EditInput {
  conv: Conversation;
  mid: string;
  html: string;
  /** Plain-text rendering of `html`, compared against the editor and the cache. */
  text: string;
}

type CachedMessage = RawMessage & { editedAt: string | null };

// The editor shows a link's text only, while htmlToText appends "(url)"; compare without those.
const squash = (s: string) =>
  s.normalize("NFC").replace(/\s*\((?:https?|mailto):[^)\s]*\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export const sameText = (a: string, b: string) => squash(a) === squash(b);

async function key(session: Session, k: string, code: string, vk: number, modifiers = 0) {
  await session.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await session.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}

async function mouse(session: Session, x: number, y: number, click: boolean) {
  await session.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (!click) return;
  await session.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function getMessage(session: Session, conversationId: string, mid: string): Promise<CachedMessage | null> {
  return session.run<CachedMessage | null>(script(GET_MESSAGE, { conversationId, mid }));
}

/**
 * Replace the content of one of your sent messages.
 *
 * Nothing is saved unless every check passes: the edit box that opened belongs to the
 * target message (by data-mid), it was emptied before pasting (pasting over a selection
 * turns it into a link), and it holds exactly the new text. Any failure before saving
 * cancels the edit box, so the message stays as it was.
 */
export async function editMessage(input: EditInput, deps: EditDeps): Promise<CachedMessage> {
  const { session, audit } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const verifyMs = deps.verifyMs ?? 15_000;
  const { conv, mid } = input;
  const attempt = randomUUID();
  const base = { action: "edit", attempt, chat: { title: conv.title, kind: conv.kind, id: conv.id }, messageId: mid };

  const before = await getMessage(session, conv.id, mid);
  if (!before) throw new CliError(`Message ${mid} is not in this chat's cache`, "MESSAGE_NOT_FOUND", ["Run `teams-cli read <chat> --ids` to find message ids"]);
  if (!before.fromMe) throw new CliError("Only your own messages can be edited", "NOT_EDITABLE");
  if (before.deleted) throw new CliError("The message was deleted", "NOT_EDITABLE");
  if (sameText(messageText({ ...before, files: [] }), input.text)) {
    return before; // idempotent: already has this text
  }
  audit({ ...base, phase: "attempt", before: before.content, html: input.html });

  let handled = false;
  const cancelAndFail = async (code: string, message: string): Promise<never> => {
    handled = true;
    try {
      await session.run(script(EDIT_CANCEL, {}));
    } catch (error) {
      if (isInteractionStop(error)) throw error;
      /* reported below */
    }
    audit({ ...base, status: "failed", error: `${code}: ${message}` });
    throw new CliError(`${message}; the message was not changed`, code);
  };

  let editOpened = false;
  try {
    await openConversation(session, conv);
    const at = await session.run<{ x: number; y: number }>(script(EDIT_LOCATE, { mid }));
    await mouse(session, at.x, at.y, false);
    await sleep(700);
    const btn = await session.run<{ x: number; y: number }>(script(EDIT_BUTTON, { mid }));
    await mouse(session, btn.x, btn.y, false);
    await mouse(session, btn.x, btn.y, true);
    editOpened = true;
    const bound = await session.run<{ bound: boolean; reason?: string; text?: string }>(script(EDIT_BOUND, { mid }));
    if (!bound.bound) return await cancelAndFail("WRONG_MESSAGE", `Refused to edit: ${bound.reason}`);

    await key(session, "a", "KeyA", 65, 2); // Ctrl+A inside the focused edit box
    await key(session, "Backspace", "Backspace", 8);
    const cleared = await session.run<{ empty: boolean }>(script(EDIT_CLEARED, { mid }));
    if (!cleared.empty) return await cancelAndFail("EDIT_NOT_CLEARED", "Could not clear the edit box");

    const pasted = await session.run<{ text: string }>(script(EDIT_PASTE, { mid, html: input.html, text: input.text }));
    if (!sameText(pasted.text, input.text)) {
      return await cancelAndFail("EDIT_MISMATCH", "The edit box does not hold exactly the new text");
    }
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    if (handled) throw error;
    if (editOpened) return await cancelAndFail(error instanceof CliError ? error.code : "EDIT_FAILED", String((error as Error).message ?? error));
    audit({ ...base, status: "failed", error: String((error as Error).message ?? error) });
    throw error;
  }

  try {
    await session.run(script(EDIT_SAVE, { mid }));
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    // A coded page error is raised before the click: nothing was saved.
    if (error instanceof PageError) return await cancelAndFail(error.code, error.message);
    // Transport failure: the save may have happened; the cache decides below.
  }

  // Saved: confirm the cache now holds the new text, marked as edited.
  const deadline = now() + verifyMs;
  let after: CachedMessage | null = null;
  while (now() < deadline) {
    await sleep(500);
    try {
      after = await getMessage(session, conv.id, mid);
    } catch (error) {
      if (isInteractionStop(error)) throw error;
      after = null;
    }
    if (after && after.edited && sameText(messageText({ ...after, files: [] }), input.text)) {
      audit({ ...base, status: "edited" });
      return after;
    }
  }
  audit({ ...base, status: "unverified" });
  throw new CliError(`Saved the edit but could not confirm it in the cache within ${Math.round(verifyMs / 1000)}s`, "EDIT_UNVERIFIED", [
    "Check with `teams-cli read <chat> --ids` before retrying",
  ]);
}
