import { commandInput } from "./command-input.js";
import { collectEvents } from "./watch.js";
import { CliError } from "./errors.js";
import { parseArgs, type ArgSpec } from "./args.js";
import { audit, auditLogPath, uiLockPath } from "./audit.js";
import { cdpUrl, openSession, script, type Session } from "./cdp.js";
import { withUiControl } from "./operation.js";
import { withLock } from "./lock.js";
import { markdownToHtml } from "./markdown.js";
import { editMessage, getMessage, sameText } from "./edit.js";
import { messageText } from "./format.js";
import { sendMessage } from "./send.js";
import { untrustedResult } from "./untrusted.js";
import { waitForMessage } from "./wait.js";
import { withObservation } from "./observation.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listAttachments, readAttachment } from "./attachments.js";
import { attachmentText } from "./attachment-data.js";
import { readCalendar } from "./calendar.js";
import { reactToMessage } from "./react.js";
import { formatTime, htmlToText, oneLine, textToHtml, truncate } from "./format.js";
import {
  formatReactions,
  presenceFromLabel,
  normalizeCall,
  type RawCall,
  normalizeAll,
  normalizeMessages,
  resolveConversation,
  type Conversation,
  type Kind,
  type RawConversation,
  type RawMessage,
} from "./model.js";
import type { Target } from "./navigate.js";
import { DOCTOR, FIND_ROOT, LIST_ACTIVITY, LIST_CALLS, LIST_CONVERSATIONS, LIST_MESSAGES, LIST_PEOPLE, LIST_PRESENCE, SEARCH_MESSAGES, USER_STATE } from "./page/scripts.js";

const BIN = "teams-cli";
type Output = Record<string, unknown>;

async function loadConversations(s: Session): Promise<Conversation[]> {
  const res = await s.run<{ meId: string; conversations: RawConversation[] }>(script(LIST_CONVERSATIONS, {}));
  return normalizeAll(res.conversations, res.meId);
}

/** Load until `want` displayable messages are found (or the cache runs out). */
async function loadMessages(s: Session, conversationId: string, want: number) {
  return s.run<{ meId: string; totalChains: number; hasMore: boolean; messages: RawMessage[] }>(
    script(LIST_MESSAGES, { conversationId, want, maxChains: Math.max(want * 4, 50) }),
  );
}

const q = (s: string) => JSON.stringify(s);

// ---------------------------------------------------------------- home

export async function home(): Promise<Output> {
  const session = await openSession();
  const target = session.target;
  const all = await loadConversations(session);
  const unread = all.filter((c) => c.unread);
  const out: Output = {
    cdp: { endpoint: cdpUrl(), target: target.webSocketDebuggerUrl },
    unread: unread.length, total: all.length, source: "local cache", chats: [],
  };
  if (unread.length) {
    out.chats = unread.slice(0, 10).map((c) => ({
      chat: c.title,
      kind: c.kind,
      from: c.lastFromName ?? "",
      when: formatTime(c.lastTime),
    }));
  }
  out.help = [
    unread.length ? `Run \`${BIN} read "<chat>"\` to see recent messages (reading never marks as read)` : `Run \`${BIN} chats\` to list recent conversations`,
    `Run \`${BIN} send "<chat>" --text "..."\` to send a message`,
    `For anything not covered, speak CDP directly to cdp.target (any CDP client works)`,
  ];
  const { chats, ...head } = out;
  return untrustedResult(head, { chats });
}

// ---------------------------------------------------------------- chats

const KINDS: Kind[] = ["self", "chat", "group", "channel", "meeting"];
const CHAT_FIELDS = ["title", "kind", "unread", "last", "from", "preview", "team", "id"] as const;
const DEFAULT_CHAT_FIELDS = ["title", "kind", "unread", "last"];

export const chatsSpec: ArgSpec = {
  command: "chats",
  flags: { unread: "boolean", kind: "string", search: "string", limit: "number", fields: "string" },
  usage: `${BIN} chats [--unread] [--kind ${KINDS.join("|")}] [--search <text>] [--limit <n>] [--fields <f,...>]`,
};

export async function chats(args: string[]): Promise<Output> {
  const { flags } = parseArgs(args, chatsSpec);
  const kind = flags.kind as string | undefined;
  if (kind && !KINDS.includes(kind as Kind)) {
    throw new CliError(`--kind must be one of ${KINDS.join(", ")}`, "VALIDATION_ERROR", [`usage: ${chatsSpec.usage}`]);
  }
  const fields = flags.fields ? String(flags.fields).split(",").map((f) => f.trim()) : DEFAULT_CHAT_FIELDS;
  const bad = fields.filter((f) => !(CHAT_FIELDS as readonly string[]).includes(f));
  if (bad.length) {
    throw new CliError(`unknown field(s): ${bad.join(", ")}`, "VALIDATION_ERROR", [`valid fields: ${CHAT_FIELDS.join(", ")}`]);
  }
  const limit = (flags.limit as number | undefined) ?? 30;
  const search = flags.search ? String(flags.search).toLowerCase() : undefined;

  const all = await loadConversations(await openSession());
  const matched = all.filter(
    (c) => (!flags.unread || c.unread) && (!kind || c.kind === kind) && (!search || c.title.toLowerCase().includes(search)),
  );
  const filters = [flags.unread && "unread", kind, search && `matching "${flags.search}"`].filter(Boolean).join(", ");
  if (matched.length === 0) {
    return {
      chats: [], count: 0, total: 0, source: "local cache",
      note: `0 ${filters || ""} conversations found in the local cache`.replace(/\s+/g, " "),
      help: [`Run \`${BIN} chats\` to list all cached conversations`],
    };
  }
  const shown = matched.slice(0, limit);
  const row = (c: Conversation): Output => {
    const r: Output = {};
    for (const f of fields) {
      if (f === "last") r.last = formatTime(c.lastTime);
      else if (f === "from") r.from = c.lastFromMe ? "me" : (c.lastFromName ?? "");
      else if (f === "preview") r.preview = truncate(c.preview, 80).text;
      else r[f] = (c as unknown as Record<string, unknown>)[f] ?? "";
    }
    return r;
  };
  const head: Output = {
    count: shown.length, total: matched.length, unread: all.filter(c => c.unread).length,
    hasMore: matched.length > shown.length, source: "local cache",
  };
  const help = [`Run \`${BIN} read "<title>"\` to see a chat's recent messages`];
  if (matched.length > shown.length) help.push(`Run \`${BIN} chats --limit ${matched.length}\` to see all ${matched.length}`);
  if (!flags.fields) help.push(`Add \`--fields title,from,preview\` for more columns (also: team, id)`);
  return untrustedResult(head, { chats: shown.map(row) }, { help });
}

// ---------------------------------------------------------------- read

export const readSpec: ArgSpec = {
  command: "read",
  flags: { limit: "number", full: "boolean", ids: "boolean", unread: "boolean" },
  positionals: ["chat"],
  usage: `${BIN} read <chat> [--limit <n>] [--unread] [--full] [--ids]`,
};

const MESSAGE_PREVIEW = 400;

export async function read(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, readSpec);
  const limit = (flags.limit as number | undefined) ?? 15;
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const res = await loadMessages(session, conv.id, limit);
  if (res.messages.some((m) => Object.keys(m.reactionUsers ?? {}).length)) {
    const people = await session.run<Array<{ mri: string; name: string | null }>>(script(LIST_PEOPLE, {}));
    const names = new Map(people.filter((p) => p.name).map((p) => [p.mri, p.name!]));
    names.set(res.meId, "you");
    for (const m of res.messages) {
      m.reactionUsers = Object.fromEntries(Object.entries(m.reactionUsers ?? {}).map(([key, ids]) => [key, ids.map((id) => names.get(id) ?? id)]));
    }
  }
  const normalized = normalizeMessages(res.messages, limit, conv.readUpTo);
  const events = normalized.events;
  const unreadCount = normalized.messages.filter((m) => m.unread).length;
  const messages = flags.unread ? normalized.messages.filter((m) => m.unread) : normalized.messages;
  let anyTruncated = false;
  const rows = messages.map((m) => {
    const t = flags.full ? { text: m.text, truncated: false } : truncate(m.text, MESSAGE_PREVIEW);
    anyTruncated ||= t.truncated;
    const text = `${m.orphan ? "(reply to an earlier post) " : ""}${t.text}${m.reactions ? ` [${m.reactions}]` : ""}`;
    const row: Output = { time: formatTime(m.time), from: m.reply ? `↳ ${m.from}` : m.from };
    // Only spend a column on read state when something in the window is unread.
    if (unreadCount && !flags.unread) row.new = m.unread;
    row.text = text;
    if (t.truncated) row.truncated = true;
    if (flags.ids) Object.assign(row, { id: m.id, thread: m.thread });
    return row;
  });
  const out: Output = {
    chat: { title: conv.title, kind: conv.kind, unread: conv.unread, id: conv.id },
  };
  if (rows.length === 0 && flags.unread && normalized.messages.length) {
    out.messages = []; out.count = 0; out.windowCount = normalized.messages.length;
    out.note = `0 unread in the latest ${normalized.messages.length} messages`;
    out.help = [`Run \`${BIN} read ${q(positionals.chat!)}\` to see them`];
    return out;
  }
  if (rows.length === 0) {
    out.messages = []; out.count = 0;
    out.note =
      res.totalChains === 0
        ? "0 messages: this chat has nothing in the local cache"
        : `0 messages in the latest ${res.totalChains} cached threads${events ? ` (only ${events} system events)` : ""}`;
    out.help = ["Open the chat once in Teams so it syncs, then read again"];
    return out;
  }
  const older = res.hasMore || res.messages.length - events > normalized.messages.length;
  out.count = rows.length;
  out.windowCount = normalized.messages.length;
  out.unread = unreadCount;
  out.hasMore = older;
  out.truncated = anyTruncated;
  out.source = "local cache";
  if (events) out.systemEventsSkipped = events;
  const help: string[] = [];
  if (anyTruncated) help.push(`Run \`${BIN} read ${q(positionals.chat!)} --full\` to see complete messages`);
  if (older) help.push(`Run \`${BIN} read ${q(positionals.chat!)} --limit ${limit * 3}\` for older messages`);
  if (!flags.ids && conv.kind === "channel") help.push(`Add \`--ids\` to see message and thread ids`);
  if (unreadCount && !flags.unread) help.push(`Add \`--unread\` to show only the ${unreadCount} unread (reading here does not mark them as read)`);
  help.push(`Run \`${BIN} send ${q(positionals.chat!)} --text "..."\` to reply`);
  return untrustedResult(out, { messages: rows }, { help });
}

// ---------------------------------------------------------------- send

export const sendSpec: ArgSpec = {
  command: "send",
  flags: { text: "string", html: "string", stdin: "boolean", markdown: "boolean", "reply-to": "string", "dry-run": "boolean", force: "boolean" },
  positionals: ["chat"],
  usage: `${BIN} send <chat> (--text <text> | --html <html> | --stdin) [--markdown] [--reply-to <messageId>] [--dry-run]`,
};

async function readStdin(): Promise<string> {
  const supplied = commandInput.getStore();
  if (supplied !== undefined) return supplied;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Refuse to drive the UI while the user is typing in Teams: our clicks and focus
 * changes would capture their keystrokes. --force overrides.
 */
export async function guardUserActivity(session: Session, force: boolean): Promise<void> {
  if (force) return;
  const st = await session.run<{ focused: boolean; visible: boolean; draft: boolean; openConversation: string | null }>(script(USER_STATE, {}));
  if (st.focused && st.draft) {
    throw new CliError("You seem to be typing in Teams (window focused, unsent draft in the open chat)", "USER_ACTIVE", [
      "Finish or send the draft, or switch away from Teams, then retry",
      "Pass --force to act anyway (your keystrokes could land in the wrong place)",
    ]);
  }
}

/** --text / --html / --stdin (+ --markdown) to the HTML to paste and its plain text. */
async function messageInput(flags: Record<string, unknown>, spec: ArgSpec): Promise<{ html: string; plain: string }> {
  const sources = (["text", "html", "stdin"] as const).filter((k) => flags[k] !== undefined);
  if (sources.length !== 1) {
    throw new CliError("Pass exactly one of --text, --html or --stdin", "VALIDATION_ERROR", [`usage: ${spec.usage}`]);
  }
  if (flags.markdown && flags.html !== undefined) {
    throw new CliError("--markdown applies to --text or --stdin, not --html", "VALIDATION_ERROR", [`usage: ${spec.usage}`]);
  }
  let html: string;
  if (flags.html !== undefined) html = String(flags.html);
  else {
    const input = flags.text !== undefined ? String(flags.text) : (await readStdin()).replace(/\n$/, "");
    if (flags.markdown) html = markdownToHtml(input);
    else if (flags.stdin && /^\s*</.test(input)) html = input;
    else html = textToHtml(input);
  }
  const plain = htmlToText(html);
  if (!plain.trim() && !/<img|<table/i.test(html)) {
    throw new CliError("Message is empty", "VALIDATION_ERROR", [`usage: ${spec.usage}`]);
  }

  return { html, plain };
}

export async function send(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, sendSpec);
  const { html, plain } = await messageInput(flags, sendSpec);
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const summary = { title: conv.title, kind: conv.kind, id: conv.id };
  let target: Target = { kind: "chat" };
  if (conv.kind === "channel") {
    const replyTo = flags["reply-to"] as string | undefined;
    if (replyTo) {
      const found = await session.run<{ rootId: string } | null>(script(FIND_ROOT, { conversationId: conv.id, messageId: replyTo }));
      if (!found) {
        throw new CliError(`Message ${replyTo} is not in this channel's cache`, "MESSAGE_NOT_FOUND", [
          `Run \`${BIN} read ${q(positionals.chat!)} --ids\` to find message and thread ids`,
        ]);
      }
      target = { kind: "reply", rootId: found.rootId };
    } else {
      target = { kind: "post" };
    }
  } else if (flags["reply-to"] !== undefined) {
    throw new CliError("--reply-to applies to channels only; chats have no threads", "VALIDATION_ERROR", [`usage: ${sendSpec.usage}`]);
  }
  if (flags["dry-run"]) {
    return {
      "dry-run": "nothing was sent",
      chat: summary,
      target: target.kind === "reply" ? `reply in thread ${target.rootId}` : target.kind === "post" ? "new channel post" : "chat message",
      preview: truncate(plain, 600).text,
      html: truncate(html, 600).text,
      help: [`Run the same command without --dry-run to send`],
    };
  }

  const lockPath = uiLockPath();
  const { message, warnings } = await withLock(lockPath, () => withUiControl(session, async () => {
    await guardUserActivity(session, !!flags.force);
    return withObservation(session, (observation) => sendMessage({ conv, target, html, text: plain }, { session, audit, observation }));
  }));
  const out: Output = {
    sent: { chat: conv.title, id: message.id, time: formatTime(message.time), ...(target.kind === "chat" ? {} : { thread: message.chainId }) },
  };
  if (warnings.length) out.warnings = warnings;
  if (conv.unread) out.note = "The chat had unread messages; opening it to send marked them as read";
  out.log = auditLogPath().replace(process.env.HOME ?? "\0", "~");
  return out;
}

// ---------------------------------------------------------------- update

/** Shadows the SDK's npm-based self-update: this package is not published. */
export async function update(args: string[]): Promise<Output> {
  parseArgs(args, { command: "update", flags: { check: "boolean", "dry-run": "boolean" }, usage: `${BIN} update [--check]` });
  return {
    update: "not available: teams-cli is not published to npm, so there is no update channel",
    help: ["Update from the git checkout: `git pull && npm install && npm run build`"],
  };
}

// ---------------------------------------------------------------- edit

export const editSpec: ArgSpec = {
  command: "edit",
  flags: { text: "string", html: "string", stdin: "boolean", markdown: "boolean", "dry-run": "boolean", force: "boolean" },
  positionals: ["chat", "messageId"],
  usage: `${BIN} edit <chat> <messageId> (--text <text> | --html <html> | --stdin) [--markdown] [--dry-run]`,
};

export async function edit(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, editSpec);
  const { html, plain } = await messageInput(flags, editSpec);
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const mid = positionals.messageId!;
  if (conv.kind === "channel") {
    throw new CliError("Editing channel messages is not implemented yet", "NOT_SUPPORTED", ["Edit it in Teams, or drive the UI over CDP (cdp.target)"]);
  }
  const current = await getMessage(session, conv.id, mid);
  if (!current) {
    throw new CliError(`Message ${mid} is not in this chat's cache`, "MESSAGE_NOT_FOUND", [`Run \`${BIN} read ${q(positionals.chat!)} --ids\` to find message ids`]);
  }
  if (!current.fromMe) throw new CliError("Only your own messages can be edited", "NOT_EDITABLE");
  const currentText = messageText({ ...current, files: [] });
  if (flags["dry-run"]) {
    return {
      "dry-run": "nothing was changed",
      chat: { title: conv.title, kind: conv.kind, id: conv.id },
      message: { id: mid, time: formatTime(current.time) },
      before: truncate(currentText, 600).text,
      after: truncate(plain, 600).text,
      html: truncate(html, 600).text,
      help: ["Run the same command without --dry-run to apply the edit"],
    };
  }
  if (sameText(currentText, plain)) return { edit: `message ${mid} already has this text (no-op)` };
  const lockPath = uiLockPath();
  const after = await withLock(lockPath, () => withUiControl(session, async () => {
    await guardUserActivity(session, !!flags.force);
    return editMessage({ conv, mid, html, text: plain }, { session, audit });
  }));
  const out: Output = { edited: { chat: conv.title, id: after.id, time: formatTime(after.time) } };
  if (conv.unread) out.note = "The chat had unread messages; opening it to edit marked them as read";
  out.log = auditLogPath().replace(process.env.HOME ?? "\0", "~");
  return out;
}

// ---------------------------------------------------------------- doctor

/** Read-only check of the CDP target, cache layout and UI contract. */
export async function doctor(args: string[]): Promise<Output> {
  parseArgs(args, { command: "doctor", flags: {}, usage: `${BIN} doctor` });
  const session = await openSession();
  const res = await session.run<{ checks: Array<{ area: string; name: string; ok: boolean; detail: string }>; lang: string; focused: boolean }>(script(DOCTOR, {}));
  const failed = res.checks.filter((c) => !c.ok);
  const out: Output = {
    target: session.target.url,
    lang: res.lang,
    result: failed.length ? `${failed.length} of ${res.checks.length} checks failed` : `all ${res.checks.length} checks passed`,
    checks: res.checks.map((c) => ({ area: c.area, check: c.name, ok: c.ok, detail: c.detail })),
  };
  if (failed.length) {
    process.exitCode = 1;
    out.help = [
      "UI checks depend on what is open: open any chat in Teams and rerun",
      "Cache failures usually mean Teams changed its internals; report the failing checks",
    ];
  }
  return out;
}

// ---------------------------------------------------------------- activity

export const activitySpec: ArgSpec = {
  command: "activity",
  flags: { unread: "boolean", limit: "number" },
  usage: `${BIN} activity [--unread] [--limit <n>]`,
};

interface ActivityRow {
  id: string; type: string; subtype: string; time: number; read: boolean; threadId: string | null; messageId: string | null;
  rootId: string | null; fromName: string | null; fromMe: boolean; messageType: string | null; content: string | null;
}

/** "mention/channel" → "mention (channel)", "reaction/heart" → "reaction ❤️". */
export function activityLabel(type: string, subtype: string): string {
  if (type === "reaction") return `reaction ${formatReactions({ [subtype]: 1 }).replace(/1$/, "") || subtype}`.trim();
  if (type === "replyToReply") return "reply (to your reply)";
  return subtype ? `${type} (${subtype})` : type;
}

export async function activity(args: string[]): Promise<Output> {
  const { flags } = parseArgs(args, activitySpec);
  const limit = (flags.limit as number | undefined) ?? 20;
  const session = await openSession();
  const titles = new Map((await loadConversations(session)).map((c) => [c.id, c.title]));
  const res = await session.run<{ total: number; unread: number; rows: ActivityRow[] }>(script(LIST_ACTIVITY, { limit, unread: !!flags.unread }));
  const head: Output = { count: res.rows.length, total: res.total, unread: res.unread, source: "local cache" };
  if (res.rows.length === 0) {
    return { ...head, items: [], note: flags.unread ? "0 unread activity items in the local cache" : "0 activity items in the local cache" };
  }
  const items = res.rows.map((r) => ({
    time: formatTime(r.time),
    what: activityLabel(r.type, r.subtype),
    chat: (r.threadId && titles.get(r.threadId)) ?? r.threadId ?? "?",
    new: !r.read,
    text: r.content === null ? "(source message not cached)" : truncate(messageText({ type: r.messageType, content: r.content }), 200).text,
    truncated: r.content !== null && truncate(messageText({ type: r.messageType, content: r.content }), 200).truncated,
    by: r.content === null ? "" : r.fromMe ? "me" : (r.fromName ?? "?"),
    id: r.messageId ?? "",
  }));
  return untrustedResult(head, { items }, {
    help: [`Run \`${BIN} read "<chat>" --ids\` to see the message in context`, `Reading here does not mark activity as read`],
  });
}

// ---------------------------------------------------------------- search

export const searchSpec: ArgSpec = {
  command: "search",
  flags: { chat: "string", limit: "number" },
  positionals: ["query"],
  usage: `${BIN} search <text> [--chat <chat>] [--limit <n>]`,
};

export async function search(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, searchSpec);
  const query = positionals.query!.trim();
  if (query.length < 2) throw new CliError("Search text must have at least 2 characters", "VALIDATION_ERROR", [`usage: ${searchSpec.usage}`]);
  const limit = (flags.limit as number | undefined) ?? 20;
  const session = await openSession();
  const all = await loadConversations(session);
  const scope = flags.chat ? resolveConversation(String(flags.chat), all, BIN) : null;
  const titles = new Map(all.map((c) => [c.id, c.title]));
  const res = await session.run<{ scanned: number; total: number; hits: Array<{ conversationId: string; id: string; time: number; fromName: string | null; fromMe: boolean; snippet: string }> }>(
    script(SEARCH_MESSAGES, { query, limit, conversationId: scope?.id ?? null }),
  );
  const head: Output = {
    count: res.hits.length, total: res.total, scanned: res.scanned, source: "local cache",
    hasMore: res.total > res.hits.length, scope: scope?.title ?? null,
  };
  if (res.total === 0) {
    return { ...head, hits: [], help: ["Only messages in Teams' local cache are searched; older ones may be missing"] };
  }
  const hits = res.hits.map((h) => ({
    time: formatTime(h.time),
    chat: titles.get(h.conversationId) ?? h.conversationId,
    from: h.fromMe ? "me" : (h.fromName ?? "?"),
    text: h.snippet,
    id: h.id,
  }));
  const help = [`Run \`${BIN} read "<chat>" --ids\` to see a match in context`];
  if (res.total > res.hits.length) help.push(`Run \`${BIN} search ${q(query)} --limit ${res.total}\` to see all ${res.total}`);
  return untrustedResult(head, { hits }, { help });
}

// ---------------------------------------------------------------- wait

export const waitSpec: ArgSpec = {
  command: "wait",
  flags: { timeout: "number", from: "string" },
  positionals: ["chat"],
  usage: `${BIN} wait <chat> [--timeout <seconds>] [--from <name>]`,
};

export async function wait(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, waitSpec);
  const seconds = (flags.timeout as number | undefined) ?? 300;
  if (seconds > 3600) throw new CliError("--timeout is at most 3600 seconds", "VALIDATION_ERROR", [`usage: ${waitSpec.usage}`]);
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const m = await withObservation(session, (observation) => waitForMessage({ conversationId: conv.id, timeoutMs: seconds * 1000, from: flags.from as string | undefined }, { session, observation }));
  const head: Output = { chat: { title: conv.title, kind: conv.kind, id: conv.id } };
  if (!m) {
    return { ...head, message: null, timedOut: true, waited: `no new message${flags.from ? ` from "${flags.from}"` : ""} in ${seconds}s`, help: [`Run the same command again to keep waiting`] };
  }
  const text = messageText({ ...m, files: m.files ?? [] });
  return untrustedResult({ ...head, timedOut: false, waited: "new message" }, { message: { time: formatTime(m.time), from: m.fromName ?? "?", text, id: m.id } }, {
    help: [`Run \`${BIN} send ${q(positionals.chat!)} --text "..."\` to reply`],
  });
}

// ---------------------------------------------------------------- presence

export const presenceSpec: ArgSpec = {
  command: "presence",
  flags: {},
  positionals: ["chat"],
  optional: ["chat"],
  usage: `${BIN} presence [<chat>]`,
};

/** Presence as shown in the left rail (read-only; only chats listed there). */
export async function presence(args: string[]): Promise<Output> {
  const { positionals } = parseArgs(args, presenceSpec);
  const session = await openSession();
  const rows = await session.run<Array<{ conversationId: string; title: string; label: string; mri: string | null; badgeLabel: string | null }>>(script(LIST_PRESENCE, {}));
  const people = rows
    .filter((r) => r.mri)
    .map((r) => ({ chat: r.title, status: r.badgeLabel || presenceFromLabel(r.label, r.title) || "unknown", id: r.conversationId }));
  if (positionals.chat) {
    const conv = resolveConversation(positionals.chat, await loadConversations(session), BIN);
    const hit = people.find((p) => p.id === conv.id);
    if (!hit) {
      throw new CliError(`No presence shown for "${conv.title}"`, "NOT_IN_SIDEBAR", ["Presence is read from the left rail; only 1:1 chats listed there have it"]);
    }
    return { count: 1, presence: [{ chat: hit.chat, status: hit.status }] };
  }
  if (!people.length) return { count: 0, presence: [], note: "0 people with presence in the left rail" };
  return { count: people.length, presence: people.map(({ chat, status }) => ({ chat, status })) };
}

// ---------------------------------------------------------------- people

export const peopleSpec: ArgSpec = {
  command: "people",
  flags: { limit: "number" },
  positionals: ["query"],
  optional: ["query"],
  usage: `${BIN} people [<name or email>] [--limit <n>]`,
};

/** People you have cached chats with: name, email, how many chats, last activity. */
export async function people(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, peopleSpec);
  const limit = (flags.limit as number | undefined) ?? 30;
  const session = await openSession();
  const all = await session.run<Array<{ mri: string; name: string | null; email: string | null; chats: number; lastTime: number }>>(script(LIST_PEOPLE, {}));
  const fold = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const query = positionals.query ? fold(positionals.query) : null;
  const matched = all
    .filter((p) => !query || fold(`${p.name ?? ""} ${p.email ?? ""}`).includes(query))
    .sort((a, b) => b.lastTime - a.lastTime);
  if (!matched.length) return { count: 0, total: 0, people: [], note: `0 people${query ? ` matching "${positionals.query}"` : ""} in cached chats` };
  return {
    count: Math.min(limit, matched.length), total: matched.length, hasMore: matched.length > limit,
    people: matched.slice(0, limit).map((p) => ({ name: p.name ?? "?", email: p.email ?? "", chats: p.chats, last: formatTime(p.lastTime) })),
  };
}

// ---------------------------------------------------------------- calls

export const callsSpec: ArgSpec = { command: "calls", flags: { limit: "number" }, usage: `${BIN} calls [--limit <n>]` };

export async function calls(args: string[]): Promise<Output> {
  const { flags } = parseArgs(args, callsSpec);
  const limit = (flags.limit as number | undefined) ?? 20;
  const session = await openSession();
  const all = (await session.run<RawCall[]>(script(LIST_CALLS, {}))).map(normalizeCall).sort((a, b) => b.time - a.time);
  if (!all.length) return { count: 0, total: 0, calls: [], note: "0 calls in the local call history" };
  return {
    count: Math.min(limit, all.length), total: all.length, hasMore: all.length > limit,
    calls: all.slice(0, limit).map((c) => ({ time: formatTime(c.time), dir: c.direction, with: c.with, outcome: c.outcome, min: c.minutes })),
  };
}


export const reactSpec: ArgSpec = {
  command: "react", flags: { remove: "boolean", "dry-run": "boolean", force: "boolean" },
  positionals: ["chat", "messageId", "key"],
  usage: `${BIN} react <chat> <messageId> <key> [--remove] [--dry-run] [--force]`,
};
export async function react(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, reactSpec);
  const key = positionals.key!;
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) throw new CliError("Use a reaction key such as like, heart, laugh or surprised", "VALIDATION_ERROR");
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const mid = positionals.messageId!;
  const message = await getMessage(session, conv.id, mid);
  if (!message || message.deleted) throw new CliError("Message is not available in this chat's cache", "MESSAGE_NOT_FOUND");
  if (flags["dry-run"]) return { "dry-run": "nothing was changed", chat: conv.title, messageId: mid, key, action: flags.remove ? "remove" : "add", current: message.myReactions ?? [] };
  const result = await withLock(uiLockPath(), () => withUiControl(session, async () => {
    await guardUserActivity(session, !!flags.force);
    return reactToMessage({ conv, mid, key, remove: !!flags.remove }, { session, audit });
  }));
  return { reaction: { ...result, chat: conv.title, messageId: mid, key }, log: auditLogPath() };
}

export const watchSpec: ArgSpec = {
  command: "watch", flags: { kind: "string", timeout: "number", limit: "number" },
  positionals: ["chat"], optional: ["chat"],
  usage: `${BIN} watch [<chat>] [--kind message|typing|presence|call] [--timeout <seconds>] [--limit <n>]`,
};
export async function watch(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, watchSpec);
  const seconds = (flags.timeout as number | undefined) ?? 30;
  const limit = (flags.limit as number | undefined) ?? 20;
  const kind = flags.kind as string | undefined;
  if (seconds > 3600 || limit > 1000 || (kind && !["message", "typing", "presence", "call"].includes(kind)))
    throw new CliError("Use timeout up to 3600s, limit up to 1000, and a listed event kind", "VALIDATION_ERROR");
  const session = await openSession();
  const conv = positionals.chat ? resolveConversation(positionals.chat, await loadConversations(session), BIN) : null;
  return withObservation(session, async (observation) => {
    const collected = await collectEvents(observation, {
      timeoutMs: seconds * 1000, limit, kind: kind as "message" | "typing" | "presence" | "call" | undefined,
      conversationId: conv?.id,
    });
    return untrustedResult({ observed: collected.length, scope: conv?.title ?? "Teams", seconds }, { events: collected }, {
      note: "Only events received during this command; no history or background listener. Missing event fields remain unknown.",
    });
  });
}


export const calendarSpec: ArgSpec = {
  command: "calendar", flags: { timeout: "number", force: "boolean" },
  usage: `${BIN} calendar [--timeout <seconds>] [--force]`,
};
export async function calendar(args: string[]): Promise<Output> {
  const { flags } = parseArgs(args, calendarSpec);
  const seconds = (flags.timeout as number | undefined) ?? 20;
  if (seconds > 120) throw new CliError("Calendar timeout is at most 120 seconds", "VALIDATION_ERROR");
  const session = await openSession();
  const views = await withLock(uiLockPath(), () => withUiControl(session, async () => {
    await guardUserActivity(session, !!flags.force);
    return readCalendar(session, seconds * 1000);
  }));
  return untrustedResult({ count: views.length, source: "Teams calendar UI responses" }, {
    views: views.map((v) => ({ calendarId: v.calendarId, from: v.start, to: v.end, timeZone: v.timeZone, events: v.items.length })),
    events: views.flatMap((v) => v.items.map((item) => ({ ...item, calendarId: v.calendarId }))),
  }, { note: "Opens Calendar and may refresh its iframe; reports only the ranges the app loaded. No events are created or changed." });
}


export const attachmentsSpec: ArgSpec = {
  command: "attachments", flags: { read: "number", output: "string", timeout: "number", "max-bytes": "number", force: "boolean" },
  positionals: ["chat", "messageId"],
  usage: `${BIN} attachments <chat> <messageId> [--read <index>] [--output <path>] [--timeout <seconds>] [--max-bytes <n>] [--force]`,
};
export async function attachments(args: string[]): Promise<Output> {
  const { positionals, flags } = parseArgs(args, attachmentsSpec);
  if (flags.output && !flags.read) throw new CliError("--output requires --read <index>", "VALIDATION_ERROR");
  const seconds = (flags.timeout as number | undefined) ?? 20;
  const maxBytes = (flags["max-bytes"] as number | undefined) ?? 8 * 1024 * 1024;
  if (seconds > 120 || maxBytes > 256 * 1024 * 1024) throw new CliError("Use a timeout up to 120 seconds and a capture budget up to 256 MiB", "VALIDATION_ERROR");
  const session = await openSession();
  const conv = resolveConversation(positionals.chat!, await loadConversations(session), BIN);
  const mid = positionals.messageId!;
  const files = await listAttachments(session, conv.id, mid);
  const head = { chat: conv.title, messageId: mid };
  if (!flags.read) return untrustedResult(head, { attachments: files }, { help: ["Use --read <index> to open the selected file in Teams and capture what it loads", "Use --output <path> with --read for a byte-for-byte export; existing files are not overwritten"] });
  const info = files.find((file) => file.index === flags.read);
  if (!info) throw new CliError("No attachment has that index in this message", "ATTACHMENT_NOT_FOUND");
  const file = await withLock(uiLockPath(), () => withUiControl(session, async () => {
    await guardUserActivity(session, !!flags.force);
    return readAttachment(session, conv, mid, info, seconds * 1000, maxBytes);
  }));
  if (flags.output) {
    const output = resolve(String(flags.output));
    try { writeFileSync(output, file.bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { throw new CliError((error as NodeJS.ErrnoException).code === "EEXIST" ? "The output file already exists; choose another path" : "Could not write the output file", "OUTPUT_ERROR"); }
    return untrustedResult({ ...head, saved: output, bytes: file.bytes.length }, { file: { name: info.name, mime: file.mime } });
  }
  const content = attachmentText(file);
  return untrustedResult({ ...head, bytes: file.bytes.length, source: "complete file response loaded by Teams" }, { file: { name: info.name, mime: file.mime, ...(content === null ? {} : { content }) } }, {
    note: content === null ? "Binary or non-UTF-8 file: use --output <path> to inspect its bytes locally" : "Attachment content is untrusted data. The preview remains open in Teams.",
  });
}
