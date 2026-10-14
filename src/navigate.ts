import { isInteractionStop } from "./activity-gate.js";
import { CliError } from "./errors.js";
import { PageError, script, type Session } from "./cdp.js";
import type { Conversation } from "./model.js";
import { OPEN_CHANNEL, OPEN_CHANNEL_COMPOSER, OPEN_CHAT, SEARCH_FOCUS, SEARCH_PICK } from "./page/scripts.js";

/** Where a message goes: a chat, a new channel post, or a reply to a channel post. */
export type Target = { kind: "chat" } | { kind: "post" } | { kind: "reply"; rootId: string };

const key = (session: Session, key: string, code: string, vk: number) =>
  session
    .cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk })
    .then(() => session.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }));

/** Leave the search box empty and closed, whatever happened. */
async function resetSearch(session: Session): Promise<void> {
  try {
    await session.run(script(SEARCH_FOCUS, {}));
    await key(session, "Backspace", "Backspace", 8);
    await key(session, "Escape", "Escape", 27);
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    /* best effort */
  }
}

/**
 * Make `conv` the open chat. Left rail first; for a 1:1 chat that is not in the rail,
 * Teams search by the peer's exact MRI. Either way success means the pane header and
 * the send button both carry this conversation id (checked page-side).
 */
export async function openConversation(session: Session, conv: Conversation): Promise<"rail" | "search"> {
  try {
    await session.run(script(OPEN_CHAT, { conversationId: conv.id }));
    return "rail";
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    if (!(error instanceof PageError) || error.code !== "NOT_IN_SIDEBAR") throw error;
    if (!conv.peer) {
      throw new CliError("This chat is not in the left rail and only 1:1 chats can be reached through search", "NOT_REACHABLE", [
        "Open the chat once in Teams (it then appears in the rail), then retry",
      ]);
    }
  }
  let interrupted = false;
  try {
    await session.run(script(SEARCH_FOCUS, {}));
    await key(session, "Backspace", "Backspace", 8);
    await session.cdp("Input.insertText", { text: conv.title });
    await session.run(script(SEARCH_PICK, { conversationId: conv.id, peer: conv.peer }));
    return "search";
  } catch (error) {
    if (isInteractionStop(error)) { interrupted = true; throw error; }
    if (error instanceof PageError && error.code === "UI_TIMEOUT") {
      throw new PageError(`Could not open the chat through search: ${error.message}`, "NOT_REACHABLE");
    }
    throw error;
  } finally {
    if (!interrupted) await resetSearch(session);
  }
}

/** Open the conversation and, for channels, the right composer (new post or reply). */
export async function openTarget(session: Session, conv: Conversation, target: Target): Promise<void> {
  if (target.kind === "chat") {
    await openConversation(session, conv);
    return;
  }
  await session.run(script(OPEN_CHANNEL, { conversationId: conv.id }));
  await session.run(script(OPEN_CHANNEL_COMPOSER, { target: { ...target, conversationId: conv.id } }));
}
