import { describe, expect, it } from "vitest";
import { PageError, type Session } from "../src/cdp.js";
import { peerOf, type Conversation } from "../src/model.js";
import { openConversation } from "../src/navigate.js";
import { OPEN_CHAT, SEARCH_FOCUS, SEARCH_PICK } from "../src/page/scripts.js";

const ME = "8:orgid:11111111-1111-1111-1111-111111111111";
const PEER = "8:orgid:22222222-2222-2222-2222-222222222222";
const ID = "19:11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222@unq.gbl.spaces";
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: ID, kind: "chat", title: "Jordan Lee", team: null, unread: false, lastTime: 0,
  lastFromName: null, lastFromMe: false, preview: "", peer: PEER, ...over,
});

function fake(fail: { open?: Error; pick?: Error } = {}) {
  const log: string[] = [];
  const args: unknown[] = [];
  const session: Session = {
    target: { id: "t", type: "page", title: "", url: "", webSocketDebuggerUrl: "" },
    run: async <T>(source: string): Promise<T> => {
      const name = source.startsWith(`(${OPEN_CHAT})`) ? "open" : source.startsWith(`(${SEARCH_FOCUS})`) ? "focus" : source.startsWith(`(${SEARCH_PICK})`) ? "pick" : "?";
      log.push(name);
      if (name === "pick") args.push(JSON.parse(source.replace(/\/\*axi:[A-Z_]+\*\/$/, "").slice(`(${SEARCH_PICK})(`.length, -1)));
      if (name === "open" && fail.open) throw fail.open;
      if (name === "pick" && fail.pick) throw fail.pick;
      return { ok: true } as T;
    },
    cdp: async (method, params) => {
      log.push(method === "Input.insertText" ? `type:${(params as { text: string }).text}` : method);
      return {};
    },
  };
  return { session, log, args };
}

describe("peerOf", () => {
  it("derives the other participant of a 1:1 chat", () => {
    expect(peerOf(ID, ME)).toBe(PEER);
    expect(peerOf(ID.replace("11111111-1111-1111-1111-111111111111_", "33333333-3333-3333-3333-333333333333_"), ME)).toBeNull();
    expect(peerOf("19:abc@thread.v2", ME)).toBeNull();
  });
});

describe("openConversation", () => {
  it("uses the left rail when the chat is there", async () => {
    const f = fake();
    await expect(openConversation(f.session, conv())).resolves.toBe("rail");
    expect(f.log).toEqual(["open"]);
  });

  it("falls back to search by the peer's exact MRI and always resets the search box", async () => {
    const f = fake({ open: new PageError("not in rail", "NOT_IN_SIDEBAR") });
    await expect(openConversation(f.session, conv())).resolves.toBe("search");
    expect(f.log.filter((l) => l.startsWith("type:"))).toEqual(["type:Jordan Lee"]);
    expect(f.args).toEqual([{ conversationId: ID, peer: PEER }]);
    const K = "Input.dispatchKeyEvent";
    // open → focus, clear, type, pick → reset: focus, clear, Escape
    expect(f.log).toEqual(["open", "focus", K, K, "type:Jordan Lee", "pick", "focus", K, K, K, K]);
  });

  it("refuses group chats that are not in the rail", async () => {
    const f = fake({ open: new PageError("not in rail", "NOT_IN_SIDEBAR") });
    await expect(openConversation(f.session, conv({ kind: "group", peer: null }))).rejects.toMatchObject({ code: "NOT_REACHABLE" });
    expect(f.log).toEqual(["open"]);
  });

  it("reports NOT_REACHABLE (a pre-send failure) when search does not surface the person", async () => {
    const f = fake({ open: new PageError("not in rail", "NOT_IN_SIDEBAR"), pick: new PageError("timed out", "UI_TIMEOUT") });
    const err = await openConversation(f.session, conv()).catch((e) => e);
    expect(err).toBeInstanceOf(PageError);
    expect(err).toMatchObject({ code: "NOT_REACHABLE" });
    expect(f.log.at(-1)).toBe("Input.dispatchKeyEvent");
  });

  it("does not swallow other open failures", async () => {
    const f = fake({ open: new PageError("pane never switched", "UI_TIMEOUT") });
    await expect(openConversation(f.session, conv())).rejects.toMatchObject({ code: "UI_TIMEOUT" });
  });
});
