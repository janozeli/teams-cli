import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { PageError, type Session } from "../src/cdp.js";
import type { Conversation, RawMessage } from "../src/model.js";
import { CLICK_SEND, COMPOSE, LIST_MESSAGES, OPEN_CHANNEL, OPEN_CHANNEL_COMPOSER, OPEN_CHAT } from "../src/page/scripts.js";
import { isOurMessage, sendMessage } from "../src/send.js";

const NOW = 1_800_000_000_000;
const conv: Conversation = {
  id: "19:ana@unq.gbl.spaces", kind: "chat", title: "Ana", team: null, unread: false,
  lastTime: 0, lastFromName: null, lastFromMe: false, preview: "", peer: null,
};
const msg = (over: Partial<RawMessage>): RawMessage => ({
  id: "1", chainId: "1", isRoot: true, time: NOW, fromId: "8:orgid:me", fromName: "Me", fromMe: true,
  type: "RichText/Html", content: "<p>hello there</p>", subject: null, files: [], deleted: false, edited: false, ...over,
});

type Step = "list" | "open" | "channel" | "composer" | "compose" | "click";
const which = (source: string): Step => {
  if (source.startsWith(`(${LIST_MESSAGES})`)) return "list";
  if (source.startsWith(`(${OPEN_CHAT})`)) return "open";
  if (source.startsWith(`(${OPEN_CHANNEL})`)) return "channel";
  if (source.startsWith(`(${OPEN_CHANNEL_COMPOSER})`)) return "composer";
  if (source.startsWith(`(${COMPOSE})`)) return "compose";
  if (source.startsWith(`(${CLICK_SEND})`)) return "click";
  throw new Error("unexpected script");
};

/** A fake page: `lists` answers successive LIST_MESSAGES calls (the last one repeats). */
function fakeSession(opts: { lists: Array<RawMessage[] | Error>; fail?: Partial<Record<Step, Error>> }) {
  const calls: Step[] = [];
  let n = 0;
  const session: Session = {
    target: { id: "t", type: "page", title: "Teams", url: "https://teams.cloud.microsoft/", webSocketDebuggerUrl: "ws://x" },
    run: async <T>(source: string): Promise<T> => {
      const step = which(source);
      calls.push(step);
      if (opts.fail?.[step]) throw opts.fail[step];
      if (step === "list") {
        const answer = opts.lists[Math.min(n++, opts.lists.length - 1)];
        if (answer instanceof Error) throw answer;
        return { totalChains: answer.length, hasMore: false, messages: answer } as T;
      }
      return { ok: true } as T;
    },
    cdp: async () => ({}),
  };
  return { session, calls };
}

function run(fake: ReturnType<typeof fakeSession>, text = "hello there", extra: Partial<Parameters<typeof sendMessage>[0]> = {}) {
  const audit: Array<Record<string, unknown>> = [];
  let clock = NOW;
  const promise = sendMessage(
    { conv, html: `<p>${text}</p>`, text, ...extra },
    { session: fake.session, audit: (e) => audit.push(e), sleep: async (ms) => void (clock += ms), now: () => clock, verifyMs: 3000 },
  );
  return { promise, audit };
}

const statuses = (audit: Array<Record<string, unknown>>) => audit.map((e) => e.status ?? e.phase);

describe("sendMessage", () => {
  it("confirms the matching new message", async () => {
    const fake = fakeSession({ lists: [[msg({ id: "old", time: NOW - 1e6 })], [msg({ id: "1790000000002" })]] });
    const { promise, audit } = run(fake);
    await expect(promise).resolves.toMatchObject({ status: "sent", message: { id: "1790000000002" } });
    expect(fake.calls).toEqual(["list", "open", "compose", "click", "list"]);
    expect(statuses(audit)).toEqual(["attempt", "sent"]);
  });

  it("fails without clicking when the composer check fails", async () => {
    const fake = fakeSession({ lists: [[]], fail: { compose: new PageError("wrong chat", "WRONG_CHAT") } });
    const { promise, audit } = run(fake);
    await expect(promise).rejects.toMatchObject({ code: "WRONG_CHAT" });
    expect(fake.calls).not.toContain("click");
    expect(statuses(audit)).toEqual(["attempt", "failed"]);
  });

  it("reports a pre-click refusal as failed and does not verify", async () => {
    const fake = fakeSession({ lists: [[]], fail: { click: new PageError("disabled", "SEND_DISABLED") } });
    const { promise, audit } = run(fake);
    await expect(promise).rejects.toMatchObject({ code: "SEND_DISABLED" });
    expect(fake.calls.filter((c) => c === "list")).toHaveLength(1);
    expect(statuses(audit)).toEqual(["attempt", "failed"]);
  });

  it("lets the cache decide when the click call itself fails in transit", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000002" })]], fail: { click: new CliError("timeout", "CDP_TIMEOUT") } });
    const { promise, audit } = run(fake);
    await expect(promise).resolves.toMatchObject({ message: { id: "1790000000002" } });
    expect(statuses(audit)).toEqual(["attempt", "sent"]);
  });

  it("does not accept an unrelated own message as confirmation", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000003", content: "<p>sent from my phone</p>" })]] });
    const { promise, audit } = run(fake);
    await expect(promise).rejects.toMatchObject({ code: "SEND_UNVERIFIED" });
    expect(statuses(audit)).toEqual(["attempt", "unverified"]);
  });

  it("waits for the server-acknowledged copy instead of the optimistic one", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "-1" })], [msg({ id: "-1" }), msg({ id: "1790000000001" })]] });
    await expect(run(fake).promise).resolves.toMatchObject({ message: { id: "1790000000001" } });
  });

  it("never confirms a message that is still in the send pipeline", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "-1" })]] });
    await expect(run(fake).promise).rejects.toMatchObject({ code: "SEND_UNVERIFIED" });
  });

  it("does not accept an old message with the same text that synced late", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000004", time: NOW - 10 * 60_000 })]] });
    await expect(run(fake).promise).rejects.toMatchObject({ code: "SEND_UNVERIFIED" });
  });

  it("stays unverified (and audited) when every verification read fails", async () => {
    const fake = fakeSession({ lists: [[], new Error("cache gone")] });
    const { promise, audit } = run(fake);
    await expect(promise).rejects.toMatchObject({ code: "SEND_UNVERIFIED" });
    expect(audit.at(-1)).toMatchObject({ status: "unverified", error: "cache gone" });
  });

  it("warns when the delivered message carries files it did not send", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000009", files: ["stale.pdf"] })]] });
    const { promise } = run(fake);
    await expect(promise).resolves.toMatchObject({ warnings: [expect.stringContaining("stale.pdf")] });
  });
});

describe("sendMessage to channels", () => {
  const channel: Conversation = { ...conv, id: "19:chan@thread.tacv2", kind: "channel", title: "Team > Dev" };

  it("opens the channel and the post composer, and confirms a new root post", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000010", chainId: "1790000000010", isRoot: true })]] });
    const { promise } = run(fake, "hello there", { conv: channel, target: { kind: "post" } });
    await expect(promise).resolves.toMatchObject({ message: { id: "1790000000010" } });
    expect(fake.calls).toEqual(["list", "channel", "composer", "compose", "click", "list"]);
  });

  it("does not take a reply as confirmation of a new post", async () => {
    const fake = fakeSession({ lists: [[], [msg({ id: "1790000000011", chainId: "1790000000001", isRoot: false })]] });
    await expect(run(fake, "hello there", { conv: channel, target: { kind: "post" } }).promise).rejects.toMatchObject({ code: "SEND_UNVERIFIED" });
  });

  it("confirms a reply only inside the chosen thread", async () => {
    const wrongThread = msg({ id: "1790000000012", chainId: "1790000000099", isRoot: false });
    const rightThread = msg({ id: "1790000000013", chainId: "1790000000001", isRoot: false });
    const fake = fakeSession({ lists: [[], [wrongThread], [wrongThread, rightThread]] });
    const { promise } = run(fake, "hello there", { conv: channel, target: { kind: "reply", rootId: "1790000000001" } });
    await expect(promise).resolves.toMatchObject({ message: { id: "1790000000013" } });
  });
});

describe("isOurMessage", () => {
  it("compares normalized text and requires own, recent messages", () => {
    expect(isOurMessage(msg({ content: "<p>Hello   there</p>" }), "hello there", NOW - 1)).toBe(true);
    expect(isOurMessage(msg({ fromMe: false }), "hello there", NOW - 1)).toBe(false);
    expect(isOurMessage(msg({}), "hello there", NOW + 1)).toBe(false);
    expect(isOurMessage(msg({}), "", NOW - 1)).toBe(false);
  });
});

it('requires response message id AND client id when observation is active', async () => {
 const fake = fakeSession({lists:[[],[msg({id:'123',clientMessageId:'456'})]]});
 let clock=NOW;
 const observation={assertHealthy:()=>{},snapshot:()=>[{kind:'send-ack',conversationId:conv.id,messageId:'123',clientMessageId:'wrong',status:201}],wait:async()=>{},close:async()=>{}} as any;
 await expect(sendMessage({conv,html:'<p>hello there</p>',text:'hello there'},{session:fake.session,audit:()=>{},observation,sleep:async(ms)=>{clock+=ms;},now:()=>clock,verifyMs:1000})).rejects.toMatchObject({code:'SEND_UNVERIFIED'});
});

it('never clicks after losing observation before send', async () => {
 const fake=fakeSession({lists:[[]]});
 const observation={assertHealthy:()=>{throw new Error('lost');}} as any;
 await expect(sendMessage({conv,html:'<p>hello there</p>',text:'hello there'},{session:fake.session,audit:()=>{},observation})).rejects.toThrow('lost');expect(fake.calls).not.toContain('click');
});

it('does not confirm a different message that shares a long prefix', () => {
 const prefix='A detailed status update '.repeat(10);
 expect(isOurMessage(msg({content:`<p>${prefix}WRONG</p>`}),`${prefix}EXPECTED`,NOW-1)).toBe(false);
});

it("does not swallow an interruption in send verification or poll again", async () => {
  const fake = fakeSession({ lists: [[], new PageError("activity", "COMMAND_INTERRUPTED")] });
  await expect(run(fake).promise).rejects.toMatchObject({ code: "COMMAND_INTERRUPTED" });
  expect(fake.calls).toEqual(["list", "open", "compose", "click", "list"]);
});
