import { currentOperation } from "./operation.js";
import { CliError } from "./errors.js";
import { script, type Session } from "./cdp.js";
import type { Conversation } from "./model.js";
import { Observer } from "./observation.js";
import { openConversation } from "./navigate.js";
import { LIST_ATTACHMENTS, OPEN_ATTACHMENT, OPEN_CHANNEL } from "./page/scripts.js";
import type { AttachmentInfo, LoadedAttachment } from "./attachment-data.js";

export async function listAttachments(session: Session, conversationId: string, mid: string): Promise<AttachmentInfo[]> {
  return session.run(script(LIST_ATTACHMENTS, { conversationId, mid }));
}

export async function readAttachment(session: Session, conv: Conversation, mid: string, info: AttachmentInfo, timeoutMs = 20000, maxBytes = 8 * 1024 * 1024): Promise<LoadedAttachment> {
  if (!info.id || !info.origin || !info.path) throw new CliError("The cache lacks the attachment identity needed to correlate its preview", "ATTACHMENT_UNAVAILABLE");
  const observer = await Observer.open(session, 2000, { attachment: { info, maxBytes }, allowTargetExit: true });
  try {
    await session.run(`(() => { const app = document.getElementById('3b64df9d-7e97-4d9c-ac5c-2e0a5d8e6f40'); if (!app) throw Error('TEAMS_CLI:NOT_REACHABLE:Chat is not in the Teams app bar'); const g = globalThis.__teamsCliGate; if (g && !g.closed) g.act("click", () => app.click(), app); else app.click(); return true; })()`, undefined, "attachments.open.chat");
    if (conv.kind === "channel") await session.run(script(OPEN_CHANNEL, { conversationId: conv.id }));
    else await openConversation(session, conv);
    observer.assertHealthy();
    await session.run(script(OPEN_ATTACHMENT, { conversationId: conv.id, channel: conv.kind === "channel", mid, file: info }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      currentOperation()?.ui?.assertAllowed();
      const file = observer.attachment();
      if (file) return file;
      await observer.wait(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    throw new CliError("Teams did not load a complete response for this attachment before the timeout", "ATTACHMENT_UNAVAILABLE", ["Check the preview in Teams; a thumbnail or a partial response is not the complete file"]);
  } finally { await observer.close(); }
}
