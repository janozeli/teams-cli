import { expect, it } from "vitest";
import { PageError, type Session } from "../src/cdp.js";
import { reactToMessage } from "../src/react.js";
import { GET_MESSAGE, REACT_CLICK } from "../src/page/scripts.js";
import type { Conversation } from "../src/model.js";
const conv = { id: "48:notes", kind: "self", title: "me" } as Conversation;
function testRun(
  options: {
    remove?: boolean;
    mine?: string[];
    fail?: Error;
    confirmed?: boolean;
  } = {},
) {
  let reads = 0,
    clock = 0;
  const calls: string[] = [];
  const logs: any[] = [];
  const session = {
    run: async (source: string) => {
      if (source.startsWith(`(${GET_MESSAGE})`)) {
        calls.push("cache");
        return {
          id: "123",
          myReactions:
            reads++ === 0
              ? (options.mine ?? [])
              : options.confirmed === false
                ? []
                : options.remove
                  ? []
                  : ["heart"],
        };
      }
      if (source.startsWith(`(${REACT_CLICK})`)) {
        calls.push("click");
        if (options.fail) throw options.fail;
        return { clicked: true };
      }
      calls.push("prepare");
      return { x: 10, y: 10 };
    },
    cdp: async () => {
      calls.push("mouse");
    },
  } as unknown as Session;
  return {
    calls,
    logs,
    promise: reactToMessage(
      { conv, mid: "123", key: "heart", remove: options.remove },
      {
        session,
        audit: (e) => logs.push(e),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        verifyMs: 1000,
      },
    ),
  };
}
it("verifies an added reaction and logs its target", async () => {
  const r = testRun();
  await expect(r.promise).resolves.toEqual({ status: "reacted" });
  expect(r.calls.at(-1)).toBe("cache");
  expect(r.logs.at(-1)).toMatchObject({
    messageId: "123",
    key: "heart",
    status: "reacted",
  });
});
it("does not toggle an already present reaction", async () => {
  const r = testRun({ mine: ["heart"] });
  await expect(r.promise).resolves.toEqual({ status: "unchanged" });
  expect(r.calls).toEqual(["cache"]);
});
it("removes an existing reaction and verifies absence", async () => {
  const r = testRun({ mine: ["heart"], remove: true });
  await expect(r.promise).resolves.toEqual({ status: "removed" });
});
it("does not continue after a wrong-message refusal", async () => {
  const r = testRun({ fail: new PageError("wrong toolbar", "WRONG_MESSAGE") });
  await expect(r.promise).rejects.toMatchObject({ code: "WRONG_MESSAGE" });
  expect(r.calls.filter((x) => x === "cache")).toHaveLength(1);
  expect(r.logs.at(-1).status).toBe("failed");
});
it("checks cache after an ambiguous click transport failure", async () => {
  const r = testRun({ fail: new Error("transport closed") });
  await expect(r.promise).resolves.toEqual({ status: "reacted" });
});
it("reports unverified instead of retrying the toggle", async () => {
  const r = testRun({ confirmed: false });
  await expect(r.promise).rejects.toMatchObject({ code: "REACT_UNVERIFIED" });
  expect(r.calls.filter((x) => x === "click")).toHaveLength(1);
});

// Execute the actual page script against a minimal DOM, so these checks are not
// merely assertions about the mocked orchestration above.
import { runInNewContext } from "node:vm";
function pageCase(
  options: {
    wrongPortal?: boolean;
    wrongTabster?: boolean;
    covered?: boolean;
    duplicate?: boolean;
  } = {},
) {
  let clicks = 0;
  const button = {
    getAttribute: (k: string) =>
      k === "data-tid"
        ? "message-actions-heart"
        : k === "aria-pressed"
          ? "false"
          : null,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20 }),
    contains: (e: any) => e === button,
    click: () => {
      clicks++;
    },
  };
  const box = {
    id: "123-popover-surface",
    getAttribute: () =>
      JSON.stringify({
        modalizer: { id: options.wrongTabster ? "other-Main" : "123-Main" },
      }),
    querySelectorAll: () => [button],
  };
  const document = {
    getElementById: () => box,
    querySelector: () => ({}),
    querySelectorAll: () =>
      options.wrongPortal ? [] : options.duplicate ? [box, box] : [box],
    elementFromPoint: () => (options.covered ? {} : button),
  };
  const result = runInNewContext(
    `(${REACT_CLICK})({conversationId:'48:notes',mid:'123',key:'heart',present:true})`,
    { document, setTimeout, Date, JSON },
  );
  return { result, clicks: () => clicks };
}
it("clicks only the portal whose two identities match the requested message", async () => {
  const p = pageCase();
  await expect(p.result).resolves.toMatchObject({ clicked: true });
  expect(p.clicks()).toBe(1);
});
for (const options of [
  { wrongPortal: true },
  { wrongTabster: true },
  { covered: true },
  { duplicate: true },
]) {
  it(`rejects a stale, mismatched, covered or duplicate portal ${JSON.stringify(options)}`, async () => {
    const p = pageCase(options);
    await expect(p.result).rejects.toThrow(/TEAMS_CLI:(WRONG_MESSAGE|UI_CHANGED)/);
    expect(p.clicks()).toBe(0);
  });
}
