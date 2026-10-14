import { describe, expect, it } from "vitest";
import { channelTitle, formatReactions, normalizeCall, presenceFromLabel, normalizeAll, normalizeMessages, normalizeMri, readHorizon, resolveConversation, type RawConversation, type RawMessage } from "../src/model.js";

const ME = "8:orgid:me";

const raw = (over: Partial<RawConversation>): RawConversation => ({
  id: "19:x@thread.v2",
  type: "Chat",
  topic: null,
  spaceName: null,
  shortTitle: "Ana Lima",
  teamId: null,
  teamName: null,
  lastTime: 1000,
  lastId: "200",
  lastFrom: "8:orgid:ana",
  lastFromName: "Ana Lima",
  lastType: "RichText/Html",
  lastContent: "<p>oi</p>",
  horizon: "100;100;1",
  members: 2,
  hidden: false,
  ...over,
});

describe("normalizeAll", () => {
  const all = normalizeAll(
    [
      raw({ id: "a", lastTime: 3 }),
      raw({ id: "b", lastTime: 2, horizon: "200;200;1" }),
      raw({ id: "c", lastTime: 1, lastFrom: `worker/${ME}` }),
      raw({ id: "48:notes", type: "StreamOfNotes", shortTitle: "Me (You)", lastTime: 9 }),
      raw({ id: "t", type: "Topic", topic: "PRs", teamName: "Dev", lastTime: 5 }),
      raw({ id: "g", members: 5, topic: "Project Chat", lastTime: 4 }),
      raw({ id: "n", type: "Thread", lastTime: 99 }),
      raw({ id: "h", hidden: true, lastTime: 98 }),
    ],
    ME,
  );
  const byId = Object.fromEntries(all.map((c) => [c.id, c]));

  it("drops system threads and hidden conversations, newest first", () => {
    expect(all.map((c) => c.id)).toEqual(["48:notes", "t", "g", "a", "b", "c"]);
  });

  it("derives kinds and titles", () => {
    expect(byId["48:notes"].kind).toBe("self");
    expect(byId.t).toMatchObject({ kind: "channel", title: "Dev > PRs" });
    expect(byId.g).toMatchObject({ kind: "group", title: "Project Chat" });
    expect(byId.a).toMatchObject({ kind: "chat", title: "Ana Lima" });
  });

  it("computes unread from the read horizon and ignores own messages", () => {
    expect(byId.a.unread).toBe(true);
    expect(byId.b.unread).toBe(false);
    expect(byId.c).toMatchObject({ unread: false, lastFromMe: true });
    expect(byId["48:notes"].unread).toBe(false);
  });
});

describe("helpers", () => {
  it("normalizeMri strips prefixes", () => {
    expect(normalizeMri("worker/8:orgid:x")).toBe("8:orgid:x");
    expect(normalizeMri(null)).toBeNull();
  });
  it("readHorizon parses the first field", () => {
    expect(readHorizon("1790;1791;42")).toBe(1790);
    expect(readHorizon(null)).toBe(0);
  });
});

describe("resolveConversation", () => {
  const all = normalizeAll(
    [
      raw({ id: "1", shortTitle: "Alex Morgan" }),
      raw({ id: "2", shortTitle: "Casey, Jordan and Alex", members: 4 }),
      raw({ id: "3", shortTitle: "André Silva" }),
      raw({ id: "48:notes", type: "StreamOfNotes", shortTitle: "Me (You)" }),
    ],
    ME,
  );

  it("matches id, alias, exact and unique substring (accent-insensitive)", () => {
    expect(resolveConversation("2", all).id).toBe("2");
    expect(resolveConversation("me", all).id).toBe("48:notes");
    expect(resolveConversation("alex morgan", all).id).toBe("1");
    expect(resolveConversation("andre", all).id).toBe("3");
  });

  it("never falls back to title matching for self aliases", () => {
    const noSelf = normalizeAll([raw({ id: "j", shortTitle: "James Smith" })], ME);
    expect(() => resolveConversation("me", noSelf)).toThrow(/own notes chat/);
    expect(() => resolveConversation("   ", noSelf)).toThrow(/empty/);
  });

  it("fails loudly on ambiguity and on no match", () => {
    expect(() => resolveConversation("alex", all)).toThrow(/matches 2 chats/);
    expect(() => resolveConversation("nobody", all)).toThrow(/No chat matches/);
  });
});

describe("normalizeMessages", () => {
  const m = (over: Partial<RawMessage>): RawMessage => ({
    id: "1", chainId: "1", isRoot: true, time: 1, fromId: "8:orgid:ana", fromName: "Ana", fromMe: false,
    type: "RichText/Html", content: "<p>hi</p>", subject: null, files: [], deleted: false, edited: false, ...over,
  });

  it("sorts oldest first, keeps the last N, skips events, marks replies and edits", () => {
    const { messages, events } = normalizeMessages(
      [
        m({ id: "3", time: 3, isRoot: false, fromMe: true }),
        m({ id: "1", time: 1 }),
        m({ id: "e", time: 2, type: "ThreadActivity/AddMember" }),
        m({ id: "2", chainId: "2", time: 2, edited: true }),
      ],
      2,
    );
    expect(events).toBe(1);
    expect(messages).toEqual([
      { id: "2", thread: "2", time: 2, from: "Ana", reply: false, orphan: false, unread: false, reactions: "", text: "hi (edited)" },
      { id: "3", thread: "1", time: 3, from: "me", reply: true, orphan: true, unread: false, reactions: "", text: "hi" },
    ]);
  });
});

describe("channelTitle", () => {
  it("names regular, team-root and child channels", () => {
    expect(channelTitle(raw({ type: "Topic", topic: "PRs", teamId: "T", teamName: "Dev Team" }))).toBe("Dev Team > PRs");
    expect(channelTitle(raw({ id: "T", type: "Space", topic: "General", spaceName: "Dev Team", teamId: "T", teamName: "Dev Team" }))).toBe(
      "Dev Team > General",
    );
    // A shared/private channel is a Space under another team, with no topic of its own.
    expect(channelTitle(raw({ id: "C", type: "Space", topic: null, spaceName: "Research", teamId: "T", teamName: "Example Team" }))).toBe(
      "Example Team > Research",
    );
  });
});

describe("orphan replies", () => {
  it("flags a reply only when its root is outside the shown window", () => {
    const base = { fromId: null, fromName: "A", fromMe: false, type: "RichText/Html", content: "<p>x</p>", subject: null, files: [], deleted: false, edited: false };
    const { messages } = normalizeMessages(
      [
        { ...base, id: "10", chainId: "10", isRoot: true, time: 10 },
        { ...base, id: "11", chainId: "10", isRoot: false, time: 11 },
        { ...base, id: "12", chainId: "5", isRoot: false, time: 12 },
      ],
      3,
    );
    expect(messages.map((m) => [m.id, m.orphan])).toEqual([["10", false], ["11", false], ["12", true]]);
  });
});

describe("read state", () => {
  const base = { fromId: null, fromName: "A", type: "RichText/Html", content: "<p>x</p>", subject: null, files: [], deleted: false, edited: false };
  it("marks others' messages newer than the read horizon as unread, never your own", () => {
    const { messages } = normalizeMessages(
      [
        { ...base, id: "100", chainId: "100", isRoot: true, time: 100, fromMe: false },
        { ...base, id: "200", chainId: "200", isRoot: true, time: 200, fromMe: false },
        { ...base, id: "300", chainId: "300", isRoot: true, time: 300, fromMe: true },
      ],
      10,
      150,
    );
    expect(messages.map((m) => [m.id, m.unread])).toEqual([["100", false], ["200", true], ["300", false]]);
  });

  it("lets a thread's own horizon win when it is newer", () => {
    const { messages } = normalizeMessages([{ ...base, id: "200", chainId: "50", isRoot: false, time: 200, fromMe: false, chainHorizon: "250" }], 10, 150);
    expect(messages[0].unread).toBe(false);
  });

  it("exposes the conversation's read horizon", () => {
    expect(normalizeAll([raw({ horizon: "1790;1791;42" })], ME)[0].readUpTo).toBe(1790);
  });
});

describe("formatReactions", () => {
  it("renders counts with glyphs and marks your own", () => {
    expect(formatReactions({ like: 2, heart: 1, party: 1 }, ["heart"])).toBe("👍2 ❤️1(you) :party:1");
    expect(formatReactions(null)).toBe("");
    expect(formatReactions({ like: 0 })).toBe("");
  });
});

describe("presenceFromLabel", () => {
  it("takes what follows the title in the rail label", () => {
    expect(presenceFromLabel("Chat Alex Morgan Ocupado", "Alex Morgan")).toBe("Ocupado");
    expect(presenceFromLabel("Chat Taylor Reed Disponível, Ausência temporária", "Taylor Reed")).toBe("Disponível, Ausência temporária");
    expect(presenceFromLabel("Chat Ana", "Ana")).toBeNull();
    expect(presenceFromLabel("Chat Ana", "Bia")).toBeNull();
  });
});

describe("normalizeCall", () => {
  it("picks the other side, outcome and talk time", () => {
    const c = normalizeCall({ start: "2026-01-01T10:00:00Z", connect: "2026-01-01T10:00:05Z", end: "2026-01-01T10:10:53Z", direction: "Incoming", type: "TwoParty", state: "Accepted", originator: "Casey", target: null, group: null });
    expect(c).toMatchObject({ direction: "in", with: "Casey", outcome: "accepted", minutes: 11 });
    expect(normalizeCall({ start: null, connect: null, end: null, direction: "Outgoing", type: null, state: "Missed", originator: "me", target: "Ana", group: null })).toMatchObject({ direction: "out", with: "Ana", outcome: "missed", minutes: null });
  });
});

it('shows known reaction actors without inventing names or duplicating you', () => {
  expect(formatReactions({like:3},['like'],{like:['you','Ana','8:orgid:unknown']})).toBe('👍3(you, Ana, 8:orgid:unknown)');
});
