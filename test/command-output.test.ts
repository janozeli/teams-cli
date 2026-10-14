import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
const run = vi.hoisted(() => vi.fn());
vi.mock("../src/cdp.js", async original => ({ ...await original<typeof import("../src/cdp.js")>(), openSession: async () => ({ target: { webSocketDebuggerUrl: "ws://fixture" }, run }) }));
import { home, chats, read, activity, search, presence, people, calls } from "../src/commands.js";
import { renderOutput } from "../src/output.js";

const conversation = { id: "48:notes", type: "StreamOfNotes", topic: null, spaceName: null, shortTitle: "Me (You)", teamId: null, teamName: null,
  lastTime: 1000, lastId: "200", lastFrom: "8:orgid:me", lastFromName: "Me", lastType: "RichText/Html", lastContent: "<p>hi</p>", horizon: "100;100;1", members: 1, hidden: false };
const conversations = { meId: "8:orgid:me", conversations: [conversation] };
const message = { id: "201", chainId: "201", isRoot: true, time: 2000, fromId: "8:orgid:me", fromName: "Me", fromMe: true, type: "RichText/Html", content: "<p>First</p><p>Second</p>", subject: null, files: [], deleted: false, edited: false };
function equivalent(result: unknown) {
  expect(typeof result).toBe("object");
  expect(parse(renderOutput(result))).toEqual(JSON.parse(renderOutput(result, "json")));
}
beforeEach(() => run.mockReset());

describe("command results remain structured", () => {
  it("keeps an empty home collection and numeric cache counts", async () => {
    run.mockResolvedValue(conversations);
    const result = await home();
    expect(result).toMatchObject({ chats: [], unread: 0, total: 1 }); equivalent(result);
  });
  it("lists and filters chats without changing collection type", async () => {
    run.mockResolvedValue(conversations);
    const result = await chats([]);
    expect(result).toMatchObject({ count: 1, total: 1, chats: [{ kind: "self" }] }); equivalent(result);
    const empty = await chats(["--search", "absent"]);
    expect(empty).toMatchObject({ count: 0, total: 0, chats: [] }); equivalent(empty);
  });
  it("preserves multiline messages and explicitly marks truncation", async () => {
    run.mockResolvedValueOnce(conversations).mockResolvedValueOnce({ meId: conversations.meId, totalChains: 1, hasMore: false, messages: [message] });
    const result = await read(["me"]);
    expect((result.messages as any[])[0].text).toContain("First\nSecond"); equivalent(result);
    const long = { ...message, content: "<p>" + "a".repeat(600) + "</p>" };
    for (const full of [false, true]) {
      run.mockResolvedValueOnce(conversations).mockResolvedValueOnce({ meId: conversations.meId, totalChains: 1, hasMore: false, messages: [long] });
      const output = await read(["me", ...(full ? ["--full"] : [])]);
      expect(output.truncated).toBe(!full);
      const text = (output.messages as any[])[0].text;
      if (full) expect(text).toContain("a".repeat(600));
      else { expect(text).toContain("… (+200 chars)"); expect(text).not.toContain("a".repeat(600)); }
      equivalent(output);
    }
  });
  it("keeps empty messages, activity and search as arrays", async () => {
    run.mockResolvedValueOnce(conversations).mockResolvedValueOnce({ meId: conversations.meId, totalChains: 0, hasMore: false, messages: [] });
    expect(await read(["me"])).toMatchObject({ count: 0, messages: [] });
    run.mockResolvedValueOnce(conversations).mockResolvedValueOnce({ total: 0, unread: 0, rows: [] });
    expect(await activity([])).toMatchObject({ count: 0, items: [] });
    run.mockResolvedValueOnce(conversations).mockResolvedValueOnce({ total: 0, scanned: 5, hits: [] });
    expect(await search(["query"])).toMatchObject({ count: 0, total: 0, hits: [] });
  });
  it.each([[presence, "presence"], [people, "people"], [calls, "calls"]] as const)("keeps empty directory/history collections", async (command, field) => {
    run.mockResolvedValue([]);
    const result = await command([]);
    expect(result[field]).toEqual([]); expect(result.count).toBe(0); equivalent(result);
  });
});
