import { describe, expect, it } from "vitest";
import type { Session } from "../src/cdp.js";
import type { RawMessage } from "../src/model.js";
import { waitForMessage } from "../src/wait.js";

const msg = (id: string, over: Partial<RawMessage> = {}): RawMessage => ({
  id, chainId: id, isRoot: true, time: Number(id), fromId: "x", fromName: "Alex Morgan", fromMe: false,
  type: "RichText/Html", content: "<p>oi</p>", subject: null, files: [], deleted: false, edited: false, ...over,
});

function run(lists: RawMessage[][], opts: { from?: string; timeoutMs?: number } = {}) {
  let n = 0;
  let clock = 0;
  const session = {
    run: async () => ({ messages: lists[Math.min(n++, lists.length - 1)] }),
  } as unknown as Session;
  return waitForMessage({ conversationId: "c", timeoutMs: opts.timeoutMs ?? 3000, from: opts.from }, { session, sleep: async (ms) => void (clock += ms), now: () => clock });
}

describe("waitForMessage", () => {
  it("returns the first new message from someone else, ignoring the baseline", async () => {
    const base = [msg("100")];
    await expect(run([base, base, [...base, msg("200")]])).resolves.toMatchObject({ id: "200" });
  });

  it("ignores your own messages and optimistic copies", async () => {
    const base = [msg("100")];
    const r = await run([base, [...base, msg("200", { fromMe: true }), msg("-1")], [...base, msg("200", { fromMe: true }), msg("300")]]);
    expect(r?.id).toBe("300");
  });

  it("filters by sender name", async () => {
    const r = await run([[], [msg("200", { fromName: "Ana" })], [msg("200", { fromName: "Ana" }), msg("300")]], { from: "alex" });
    expect(r?.id).toBe("300");
  });

  it("returns null on timeout", async () => {
    await expect(run([[msg("100")]], { timeoutMs: 2000 })).resolves.toBeNull();
  });
});

it('retains an arrival already present in the baseline when it was observed after arming', async () => {
 const calls:string[]=[];const incoming=msg('200');
 const observation={assertHealthy:()=>calls.push('armed'),snapshot:()=>[{kind:'message',change:'NewMessage',conversationId:'c',messageId:'200',at:0}],wait:async()=>{},close:async()=>{}} as any;
 const session={run:async(source:string)=>{if(source.includes('maxChains":80')){calls.push('baseline');return {messages:[msg('100'),incoming]};}return incoming;}} as unknown as Session;
 const result=await waitForMessage({conversationId:'c',timeoutMs:1000},{session,observation});
 expect(result?.id).toBe('200');expect(calls[0]).toBe('armed');expect(calls[1]).toBe('baseline');
});

it('propagates observation loss rather than returning a timeout',async()=>{
 const observation={assertHealthy:()=>{throw new Error('observation lost');}} as any;
 await expect(waitForMessage({conversationId:'c',timeoutMs:1000},{session:{} as Session,observation})).rejects.toThrow('observation lost');
});
