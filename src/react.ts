import { isInteractionStop } from "./activity-gate.js";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import { PageError, script, type Session } from "./cdp.js";
import { getMessage } from "./edit.js";
import type { Conversation } from "./model.js";
import { openConversation } from "./navigate.js";
import { EDIT_LOCATE, REACT_CLICK } from "./page/scripts.js";

export interface ReactInput {
  conv: Conversation;
  mid: string;
  key: string;
  remove?: boolean;
}
export interface ReactDeps {
  session: Session;
  audit: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  verifyMs?: number;
}

/** Idempotent set/remove, never a blind reaction toggle. */
export async function reactToMessage(
  input: ReactInput,
  deps: ReactDeps,
): Promise<{ status: "reacted" | "removed" | "unchanged" }> {
  const { session, audit } = deps;
  const sleep =
    deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const { conv, mid, key } = input;
  const present = !input.remove;
  const base = {
    action: "react",
    attempt: randomUUID(),
    conversationId: conv.id,
    messageId: mid,
    key,
    present,
  };
  audit({ ...base, phase: "attempt" });
  try {
    if (conv.kind === "channel")
      throw new CliError(
        "Channel reactions need a channel message surface",
        "NOT_SUPPORTED",
      );
    const current = await getMessage(session, conv.id, mid);
    if (!current || current.deleted)
      throw new CliError(
        "Message is not available in this chat's cache",
        "MESSAGE_NOT_FOUND",
      );
    if ((current.myReactions ?? []).includes(key) === present) {
      audit({ ...base, status: "unchanged" });
      return { status: "unchanged" };
    }
    await openConversation(session, conv);
    // Leave any previous hover target before entering this message again. Teams
    // can otherwise keep a stale portal when the pointer's coordinates did not move.
    await session.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 0,
      y: 0,
    });
    await sleep(150);
    const at = await session.run<{ x: number; y: number }>(
      script(EDIT_LOCATE, { mid }),
    );
    await session.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: at.x,
      y: at.y,
    });
    await sleep(700);
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    audit({ ...base, status: "failed" });
    throw error;
  }
  let clicked = true;
  try {
    ({ clicked } = await session.run<{ clicked: boolean }>(
      script(REACT_CLICK, { conversationId: conv.id, mid, key, present }),
    ));
  } catch (error) {
    if (isInteractionStop(error)) throw error;
    if (error instanceof PageError) {
      audit({ ...base, status: "failed", code: error.code });
      throw error;
    }
    // A transport failure after dispatch cannot prove whether the click happened.
  }
  const deadline = now() + (deps.verifyMs ?? 15000);
  while (now() < deadline) {
    await sleep(250);
    const current = await getMessage(session, conv.id, mid).catch(error => { if (isInteractionStop(error)) throw error; return null; });
    if (current && (current.myReactions ?? []).includes(key) === present) {
      const status = !clicked ? "unchanged" : present ? "reacted" : "removed";
      audit({ ...base, status });
      return { status };
    }
  }
  audit({ ...base, status: "unverified" });
  throw new CliError(
    "Could not confirm the reaction; inspect the message before retrying",
    "REACT_UNVERIFIED",
  );
}
