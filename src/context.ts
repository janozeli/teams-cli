import { withOperation } from "./operation.js";
import { renderOutput } from "./output.js";
import { openSession, script, setTransport, webSocketTransport, type Transport } from "./cdp.js";
import { normalizeAll, type RawConversation } from "./model.js";
import { LIST_CONVERSATIONS } from "./page/scripts.js";

/**
 * Ambient context for agent session start: a few lines, never an error.
 * It loads on every session, so it stays tiny and bounded in time.
 */
export async function sessionContext(timeoutMs = 3000): Promise<string> {
  try { return renderOutput(await withOperation("context", () => loadContext(timeoutMs))); }
  catch { return renderOutput({ teams: "unavailable (could not record session context)" }); }
}

async function loadContext(timeoutMs: number): Promise<Record<string, unknown>> {
  const bounded: Transport = (target, source) => webSocketTransport(target, source, timeoutMs);
  setTransport(bounded);
  try {
    const session = await openSession();
    const res = await session.run<{ meId: string; conversations: RawConversation[] }>(script(LIST_CONVERSATIONS, {}));
    const unread = normalizeAll(res.conversations, res.meId).filter((c) => c.unread);
    const top = unread.slice(0, 3).map((c) => c.title);
    const more = unread.length > top.length ? ` +${unread.length - top.length} more` : "";
    return {
      teams: unread.length ? `${unread.length} unread: ${top.join("; ")}${more}` : "no unread chats",
      help: ["Run `teams-cli` for details, `teams-cli read <chat>` to read (does not mark as read)"],
    };
  } catch (error) {
    return { teams: `unavailable (${(error as Error).message})` };
  }
}
