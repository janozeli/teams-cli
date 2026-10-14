import { CliError } from "./errors.js";
import { messageText, oneLine } from "./format.js";

/** Raw conversation as returned by the LIST_CONVERSATIONS page script. */
export interface RawConversation {
  id: string;
  type: string;
  topic: string | null;
  /** A Space's own name (spaceThreadTopic); null for other types. */
  spaceName: string | null;
  shortTitle: string | null;
  teamId: string | null;
  /** Name of the Space that `teamId` points at. */
  teamName: string | null;
  lastTime: number;
  lastId: string | null;
  lastFrom: string | null;
  lastFromName: string | null;
  lastType: string | null;
  lastContent: string;
  horizon: string | null;
  members: number | null;
  hidden: boolean;
}

export type Kind = "self" | "chat" | "group" | "channel" | "meeting";

export interface Conversation {
  id: string;
  kind: Kind;
  title: string;
  team: string | null;
  unread: boolean;
  lastTime: number;
  lastFromName: string | null;
  lastFromMe: boolean;
  preview: string;
  /** Id (a timestamp) of the last message the user has read in this conversation. */
  readUpTo: number;
  /** For 1:1 chats, the other person's MRI (derived from the conversation id). */
  peer: string | null;
}

/** 1:1 chat ids are "19:<userA>_<userB>@unq.gbl.spaces"; the peer is the one that is not me. */
export function peerOf(id: string, meId: string): string | null {
  const m = /^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i.exec(id);
  if (!m) return null;
  const me = meId.replace(/^8:orgid:/, "");
  const other = m[1] === me ? m[2] : m[2] === me ? m[1] : null;
  return other && other !== me ? `8:orgid:${other}` : null;
}

const KIND_BY_TYPE: Record<string, Kind | undefined> = {
  StreamOfNotes: "self",
  Chat: "chat",
  Topic: "channel",
  Space: "channel",
  Meeting: "meeting",
};

/** Strip the `worker/` style prefixes Teams puts in front of MRIs. */
export function normalizeMri(mri: string | null): string | null {
  if (!mri) return null;
  const at = mri.search(/\d+:/);
  return at >= 0 ? mri.slice(at) : mri;
}

/** Last message id read by the user, from `consumptionhorizon` ("readId;readTime;clientMsgId"). */
export function readHorizon(horizon: string | null): number {
  const first = horizon?.split(";")[0];
  const n = first ? Number(first) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Channel titles are "<team> > <channel>". Three cached shapes:
 * - Topic: a regular channel; its team is the Space `teamId` points at.
 * - Space with teamId == id: the team itself, which is also its General channel.
 * - Space with teamId != id: a shared/private channel living under another team;
 *   its own spaceThreadTopic is the channel name.
 */
export function channelTitle(raw: RawConversation): string {
  if (raw.type === "Topic") return `${raw.teamName ?? "?"} > ${raw.topic ?? "?"}`;
  const isTeamRoot = !raw.teamId || raw.teamId === raw.id;
  if (isTeamRoot) return `${raw.spaceName ?? raw.teamName ?? "?"} > ${raw.topic ?? "General"}`;
  return `${raw.teamName ?? "?"} > ${raw.spaceName ?? raw.topic ?? "?"}`;
}

export function normalizeConversation(raw: RawConversation, meId: string): Conversation | null {
  const baseKind = KIND_BY_TYPE[raw.type];
  if (!baseKind || raw.hidden) return null;
  const kind: Kind = baseKind === "chat" && (raw.members ?? 0) > 2 ? "group" : baseKind;
  const title = kind === "channel" ? channelTitle(raw) : (raw.topic || raw.shortTitle || raw.id).trim();
  const lastFromMe = normalizeMri(raw.lastFrom) === meId;
  const lastId = raw.lastId ? Number(raw.lastId) : 0;
  const unread = kind !== "self" && !lastFromMe && lastId > 0 && lastId > readHorizon(raw.horizon);
  const preview = oneLine(messageText({ type: raw.lastType, content: raw.lastContent }));
  const team = kind !== "channel" ? null : raw.type === "Space" && (!raw.teamId || raw.teamId === raw.id) ? raw.spaceName : raw.teamName;
  const peer = kind === "chat" ? peerOf(raw.id, meId) : null;
  return { id: raw.id, kind, title, team, unread, lastTime: raw.lastTime, lastFromName: raw.lastFromName, lastFromMe, preview, peer, readUpTo: readHorizon(raw.horizon) };
}

export function normalizeAll(raws: RawConversation[], meId: string): Conversation[] {
  return raws
    .map((r) => normalizeConversation(r, meId))
    .filter((c): c is Conversation => c !== null)
    .sort((a, b) => b.lastTime - a.lastTime);
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const SELF_ALIASES = new Set(["me", "self", "notes", "eu", "voce"]);

/**
 * Resolve a user-supplied chat reference: exact id, a self alias, an exact title,
 * or a unique case/accent-insensitive substring of the title.
 */
export function resolveConversation(query: string, all: Conversation[], bin = "teams-cli"): Conversation {
  const byId = all.find((c) => c.id === query);
  if (byId) return byId;
  const q = fold(query);
  if (!q) throw new CliError("Chat reference is empty", "VALIDATION_ERROR", [`Run \`${bin} chats\` to list chats`]);
  // Aliases are exclusive: never fall back to title matching (e.g. "me" inside "James").
  if (SELF_ALIASES.has(q)) {
    const self = all.find((c) => c.kind === "self");
    if (self) return self;
    throw new CliError(`"${query}" means your own notes chat, which is not in the local cache`, "CHAT_NOT_FOUND", [
      "Open your own chat once in Teams so it is cached, or pass another chat's exact title or id",
    ]);
  }
  const exact = all.filter((c) => fold(c.title) === q);
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : all.filter((c) => fold(c.title).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) {
    throw new CliError(`No chat matches "${query}"`, "CHAT_NOT_FOUND", [
      `Run \`${bin} chats --search "<text>"\` to find the chat`,
      "Only conversations in Teams' local cache are visible; open older chats in Teams once to cache them",
    ]);
  }
  const shown = partial.slice(0, 6).map((c) => `${c.title} (${c.kind}) id=${c.id}`);
  throw new CliError(`"${query}" matches ${partial.length} chats`, "AMBIGUOUS_CHAT", [
    ...shown,
    `Use a more specific title or pass the exact id: \`${bin} read "<id>"\``,
  ]);
}

/** Raw message as returned by the LIST_MESSAGES page script. */
export interface RawMessage {
  id: string;
  chainId: string;
  isRoot: boolean;
  time: number;
  fromId: string | null;
  fromName: string | null;
  fromMe: boolean;
  type: string | null;
  content: string;
  subject: string | null;
  files: string[];
  deleted: boolean;
  edited: boolean;
  clientMessageId?: string | null;
  state?: number | null;
  /** Non-null while Teams' send pipeline still owns the message. */
  sendStatus?: string | null;
  /** The thread's own read horizon (channel reply chains), when Teams keeps one. */
  chainHorizon?: string | null;
  /** Reaction counts by key (like, heart, laugh, ...). */
  reactions?: Record<string, number> | null;
  /** Reaction keys the user added. */
  myReactions?: string[];
  /** Cached actor ids, resolved to display names by the read command when available. */
  reactionUsers?: Record<string, string[]>;
}

const REACTION_GLYPHS: Record<string, string> = {
  like: "👍", heart: "❤️", laugh: "😆", surprised: "😮", sad: "😢", angry: "😡",
};

/** "👍2 ❤️1(you)" — compact, and says which ones are yours. */
export function formatReactions(counts: Record<string, number> | null | undefined, mine: string[] = [], users: Record<string, string[]> = {}): string {
  if (!counts) return "";
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const people = [...new Set(users[k] ?? [])];
      if (mine.includes(k) && !people.includes("you")) people.unshift("you");
      return `${REACTION_GLYPHS[k] ?? `:${k}:`}${n}${people.length ? `(${people.join(", ")})` : ""}`;
    })
    .join(" ");
}

/**
 * The server acknowledged the message: it has a server-assigned numeric id.
 * While sending, Teams caches an optimistic copy with id "-1".
 */
export function isDelivered(m: RawMessage): boolean {
  return /^[1-9]\d*$/.test(m.id) && !m.sendStatus;
}

export interface Message {
  id: string;
  /** Root message id of the thread this message belongs to. */
  thread: string;
  time: number;
  from: string;
  reply: boolean;
  /** A reply whose root post is not among the returned messages. */
  orphan: boolean;
  /** Not yet read by the user (never true for your own messages). */
  unread: boolean;
  /** Formatted reactions, empty when none. */
  reactions: string;
  text: string;
}

/**
 * Keep real messages (drop membership/system events), oldest first, last `limit`.
 * `readUpTo` is the conversation's read horizon; a thread's own horizon wins when newer.
 */
export function normalizeMessages(raws: RawMessage[], limit: number, readUpTo = Infinity): { messages: Message[]; events: number } {
  let events = 0;
  const messages: Message[] = [];
  for (const m of raws) {
    const text = messageText(m);
    if (!text) {
      events++;
      continue;
    }
    messages.push({
      id: m.id,
      thread: m.chainId,
      time: m.time,
      from: m.fromMe ? "me" : (m.fromName ?? "?"),
      reply: !m.isRoot,
      orphan: false,
      unread: !m.fromMe && Number(m.id) > Math.max(readUpTo, Number(m.chainHorizon) || 0),
      reactions: formatReactions(m.reactions, m.myReactions, m.reactionUsers),
      text: m.edited && !m.deleted ? `${text} (edited)` : text,
    });
  }
  messages.sort((a, b) => a.time - b.time);
  const shown = messages.slice(-limit);
  const roots = new Set(shown.filter((m) => !m.reply).map((m) => m.id));
  for (const m of shown) m.orphan = m.reply && !roots.has(m.thread);
  return { messages: shown, events };
}

/** Status from a rail label "Chat <title> <status>" (e.g. "Chat Alex Morgan Ocupado"). */
export function presenceFromLabel(label: string, title: string): string | null {
  const clean = label.replace(/\s+/g, " ").trim();
  const at = clean.indexOf(title);
  if (at < 0) return null;
  const rest = clean.slice(at + title.length).trim();
  return rest || null;
}

export interface RawCall {
  start: string | null; connect: string | null; end: string | null;
  direction: string | null; type: string | null; state: string | null;
  originator: string | null; target: string | null; group: string | null;
}

export interface Call { time: number; direction: string; with: string; outcome: string; minutes: number | null }

/** Who the call was with (the other side), its outcome and length in minutes. */
export function normalizeCall(c: RawCall): Call {
  const ms = (s: string | null) => (s ? Date.parse(s) : NaN);
  const incoming = (c.direction ?? "").toLowerCase() === "incoming";
  const other = (incoming ? c.originator : c.target) ?? (incoming ? c.target : c.originator) ?? (c.group ? "group call" : "?");
  const talked = ms(c.end) - ms(c.connect);
  return {
    time: Number.isFinite(ms(c.start)) ? ms(c.start) : 0,
    direction: incoming ? "in" : (c.direction ?? "").toLowerCase() === "outgoing" ? "out" : (c.direction ?? "?"),
    with: other,
    outcome: (c.state ?? "?").toLowerCase(),
    minutes: Number.isFinite(talked) && talked >= 0 ? Math.round(talked / 60000) : null,
  };
}
