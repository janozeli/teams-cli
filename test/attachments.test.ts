import { afterEach, expect, it, vi } from "vitest";
import { readAttachment } from "../src/attachments.js";
import { Observer } from "../src/observation.js";
import * as navigation from "../src/navigate.js";
import type { Session } from "../src/cdp.js";
import type { Conversation } from "../src/model.js";
import type { AttachmentInfo } from "../src/attachment-data.js";
afterEach(() => vi.restoreAllMocks());
const info: AttachmentInfo = { index: 1, id: "id", name: "f.md", type: "md", origin: "https://tenant.sharepoint.com", path: "/f.md" };
const conv = { id: "48:notes", kind: "chat" } as Conversation;
function fixture(fail = false, missing = false) {
  let now = 0; vi.spyOn(Date, "now").mockImplementation(() => now);
  const steps: string[] = [];
  const file = { info, mime: "text/plain", bytes: Buffer.from("content") };
  const observer = { assertHealthy: () => {}, attachment: () => missing ? undefined : file, wait: async (ms: number) => { now += ms; }, close: async () => { steps.push("closed"); } };
  vi.spyOn(Observer, "open").mockImplementation(async () => { steps.push("armed"); return observer as any; });
  vi.spyOn(navigation, "openConversation").mockImplementation(async () => { steps.push("chat"); });
  const session = { run: async () => { steps.push("UI"); if (fail) throw Error("UI failed"); } } as unknown as Session;
  return { steps, file, promise: readAttachment(session, conv, "123", info, 1000) };
}
it("arms before navigation and opening the file, always closes after capture", async () => {
  const r = fixture(); await expect(r.promise).resolves.toEqual(r.file);
  expect(r.steps).toEqual(["armed", "UI", "chat", "UI", "closed"]);
});
it("closes after UI failure and reports missing content instead of thumbnail success", async () => {
  const failure = fixture(true); await expect(failure.promise).rejects.toThrow("UI failed"); expect(failure.steps.at(-1)).toBe("closed");
  const missing = fixture(false, true); await expect(missing.promise).rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" }); expect(missing.steps.at(-1)).toBe("closed");
});

import { runInNewContext } from "node:vm";
import { OPEN_ATTACHMENT } from "../src/page/scripts.js";
function pageCase(options: { wrongChat?: boolean; otherMessage?: boolean; wrongPath?: boolean; duplicate?: boolean } = {}) {
  let opens = 0;
  const tile = {
    getAttribute: (k: string) => k === "index" ? "0" : "f.md",
    querySelector: () => ({ getAttribute: () => "f.md\nhttps://tenant.sharepoint.com/" + (options.wrongPath ? "other.md" : "f.md") }),
    scrollIntoView: () => {}, focus: () => {}, dispatchEvent: () => { opens++; },
  };
  const msg = { querySelector: () => ({}), querySelectorAll: (sel: string) => sel === "[data-mid]" ? [{ getAttribute: () => options.otherMessage ? "other" : "123" }] : options.duplicate ? [tile, tile] : [tile] };
  const document = { querySelector: (sel: string) => sel.startsWith("[id=") ? options.wrongChat ? null : {} : msg };
  const result = runInNewContext(`(${OPEN_ATTACHMENT})(${JSON.stringify({ conversationId: "48:notes", mid: "123", file: info })})`, { document, URL, KeyboardEvent: class {}, setTimeout, Date, JSON });
  return { result, opens: () => opens };
}
it("executes the real page script only on the bound message and file tile", async () => {
  const p = pageCase(); await expect(p.result).resolves.toEqual({ opened: true }); expect(p.opens()).toBe(1);
});
it.each([{ wrongChat: true }, { otherMessage: true }, { wrongPath: true }, { duplicate: true }])("refuses an ambiguous or changed attachment target %j", async options => {
  const p = pageCase(options); await expect(p.result).rejects.toThrow(/TEAMS_CLI:(WRONG_CHAT|WRONG_MESSAGE|ATTACHMENT_UNAVAILABLE)/); expect(p.opens()).toBe(0);
});
