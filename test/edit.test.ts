import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { PageError, type Session } from "../src/cdp.js";
import { editMessage, sameText } from "../src/edit.js";
import type { Conversation } from "../src/model.js";
import * as S from "../src/page/scripts.js";

const conv: Conversation = { id: "48:notes", kind: "self", title: "Me", team: null, unread: false, lastTime: 0, lastFromName: null, lastFromMe: true, preview: "", peer: null };
const MID = "1790000000100";
const cached = (content: string, over: Record<string, unknown> = {}) => ({
  id: MID, chainId: MID, isRoot: true, time: 1, fromId: "me", fromName: "Me", fromMe: true, type: "RichText/Html",
  content, subject: null, files: [], deleted: false, edited: false, editedAt: null, ...over,
});

const NAMES: Array<[string, string]> = [
  ["getMessage", S.GET_MESSAGE], ["open", S.OPEN_CHAT], ["locate", S.EDIT_LOCATE], ["button", S.EDIT_BUTTON], ["bound", S.EDIT_BOUND],
  ["cleared", S.EDIT_CLEARED], ["paste", S.EDIT_PASTE], ["save", S.EDIT_SAVE], ["cancel", S.EDIT_CANCEL],
];
const nameOf = (src: string) => NAMES.find(([, body]) => src.startsWith(`(${body})`))?.[0] ?? "?";

type Answers = Partial<Record<string, unknown | Error | Array<unknown>>>;
function fake(answers: Answers) {
  const calls: string[] = [];
  const counters: Record<string, number> = {};
  const session: Session = {
    target: { id: "t", type: "page", title: "", url: "", webSocketDebuggerUrl: "" },
    run: async <T>(source: string): Promise<T> => {
      const name = nameOf(source);
      calls.push(name);
      let a = answers[name];
      if (Array.isArray(a)) a = a[Math.min((counters[name] = (counters[name] ?? -1) + 1), a.length - 1)];
      if (a instanceof Error) throw a;
      return (a ?? { ok: true }) as T;
    },
    cdp: async (method, params) => {
      calls.push(method === "Input.dispatchKeyEvent" ? `key:${(params as { key: string }).key}:${(params as { type: string }).type}` : method);
      return {};
    },
  };
  return { session, calls };
}

const happy = (over: Answers = {}): Answers => ({
  getMessage: [cached("<p>old text</p>"), cached("<p>new text</p>", { edited: true })],
  locate: { x: 10, y: 10 }, button: { x: 20, y: 20 }, bound: { bound: true, text: "old text" },
  cleared: { empty: true }, paste: { text: "new text" }, ...over,
});

function run(answers: Answers, text = "new text") {
  const f = fake(answers);
  const audit: Array<Record<string, unknown>> = [];
  let clock = 0;
  const promise = editMessage({ conv, mid: MID, html: `<p>${text}</p>`, text }, {
    session: f.session, audit: (e) => audit.push(e), sleep: async (ms) => void (clock += ms), now: () => clock, verifyMs: 3000,
  });
  return { promise, audit, calls: f.calls };
}
const statuses = (audit: Array<Record<string, unknown>>) => audit.map((e) => e.status ?? e.phase);

describe("editMessage", () => {
  it("clears before pasting, saves, and confirms the edit in the cache", async () => {
    const r = run(happy());
    await expect(r.promise).resolves.toMatchObject({ edited: true });
    const i = (n: string) => r.calls.indexOf(n);
    expect(i("key:Backspace:keyDown")).toBeGreaterThan(i("key:a:keyDown"));
    expect(i("cleared")).toBeGreaterThan(i("key:Backspace:keyDown"));
    expect(i("paste")).toBeGreaterThan(i("cleared"));
    expect(i("save")).toBeGreaterThan(i("paste"));
    expect(r.calls).not.toContain("cancel");
    expect(statuses(r.audit)).toEqual(["attempt", "edited"]);
    expect(r.audit[0].before).toBe("<p>old text</p>"); // previous content kept for undo
  });

  it("cancels, without saving, when the edit box belongs to another message", async () => {
    const r = run(happy({ bound: { bound: false, reason: "the edit box that opened belongs to another message" } }));
    await expect(r.promise).rejects.toMatchObject({ code: "WRONG_MESSAGE" });
    expect(r.calls).toContain("cancel");
    expect(r.calls).not.toContain("paste");
    expect(r.calls).not.toContain("save");
  });

  it("cancels when the box could not be cleared (pasting over a selection makes a link)", async () => {
    const r = run(happy({ cleared: { empty: false } }));
    await expect(r.promise).rejects.toMatchObject({ code: "EDIT_NOT_CLEARED" });
    expect(r.calls).not.toContain("paste");
    expect(r.calls).toContain("cancel");
  });

  it("cancels when the box does not hold exactly the new text", async () => {
    const r = run(happy({ paste: { text: "old textnew text" } }));
    await expect(r.promise).rejects.toMatchObject({ code: "EDIT_MISMATCH" });
    expect(r.calls).not.toContain("save");
    expect(r.calls).toContain("cancel");
  });

  it("cancels when a page check fails mid-way (after the box opened)", async () => {
    const r = run(happy({ paste: new PageError("gone", "WRONG_MESSAGE") }));
    await expect(r.promise).rejects.toMatchObject({ code: "WRONG_MESSAGE" });
    expect(r.calls).toContain("cancel");
    expect(statuses(r.audit)).toEqual(["attempt", "failed"]);
  });

  it("does not click anything when the Edit button never appears", async () => {
    const r = run(happy({ button: new PageError("no edit action", "NOT_EDITABLE") }));
    await expect(r.promise).rejects.toMatchObject({ code: "NOT_EDITABLE" });
    expect(r.calls.filter((c) => c === "Input.dispatchMouseEvent")).toHaveLength(1); // the hover only
    expect(r.calls).not.toContain("cancel");
  });

  it("lets the cache decide when the save call fails in transit", async () => {
    const r = run(happy({ save: new CliError("timeout", "CDP_TIMEOUT") }));
    await expect(r.promise).resolves.toMatchObject({ edited: true });
  });

  it("reports EDIT_UNVERIFIED when the cache never shows the new text", async () => {
    const r = run(happy({ getMessage: [cached("<p>old text</p>"), cached("<p>old text</p>")] }));
    await expect(r.promise).rejects.toMatchObject({ code: "EDIT_UNVERIFIED" });
    expect(statuses(r.audit)).toEqual(["attempt", "unverified"]);
  });

  it("is a no-op when the message already has the text, and refuses others' messages", async () => {
    const same = run(happy({ getMessage: [cached("<p>new text</p>")] }));
    await expect(same.promise).resolves.toBeDefined();
    expect(same.calls).toEqual(["getMessage"]);
    await expect(run(happy({ getMessage: [cached("<p>x</p>", { fromMe: false })] })).promise).rejects.toMatchObject({ code: "NOT_EDITABLE" });
  });
});

describe("sameText", () => {
  it("ignores whitespace, case and the (url) that htmlToText appends to links", () => {
    expect(sameText("Veja a issue #1 (https://x.io/1)\n\nfim", "veja a issue #1 fim")).toBe(true);
    expect(sameText("a", "b")).toBe(false);
  });
});

for (const phase of ["bound", "paste", "save"]) it(`does not cancel or retry an edit interrupted during ${phase}`, async () => {
  const r = run(happy({ [phase]: new PageError("activity", "COMMAND_INTERRUPTED") }));
  await expect(r.promise).rejects.toMatchObject({ code: "COMMAND_INTERRUPTED" });
  expect(r.calls).not.toContain("cancel");
  if (phase !== "save") expect(r.calls).not.toContain("save");
});
