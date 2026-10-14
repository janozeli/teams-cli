import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, type ProtocolEvent } from "../src/connection.js";
import { Observer, decodePush, messageAddress } from "../src/observation.js";
import type { Session } from "../src/cdp.js";
class Wire {
  handler: (e: ProtocolEvent) => void = () => {};
  end: () => void = () => {};
  calls: string[] = [];
  closed = false;
  responseBody: unknown = {};
  rawBody?: { body: string; base64Encoded: boolean };
  bodyReads: string[] = [];
  workerReady?: () => void;
  onEvent(fn: any) {
    this.handler = fn;
    return () => {
      this.handler = () => {};
    };
  }
  onClose(fn: any) {
    this.end = fn;
    return () => {
      this.end = () => {};
    };
  }
  async call(method: string, params: any = {}, sid?: string) {
    this.calls.push(`${sid ?? "page"}:${method}`);
    if (method === "Target.setAutoAttach" && !sid)
      this.emit("Target.attachedToTarget", {
        sessionId: "worker",
        targetInfo: { type: "worker" },
      });
    if (method === "Network.enable" && sid === "worker")
      await new Promise<void>((r) => {
        this.workerReady = r;
      });
    if (method === "Network.getResponseBody") { this.bodyReads.push(params.requestId); return this.rawBody ?? { body: JSON.stringify(this.responseBody), base64Encoded: false }; }
    return {};
  }
  emit(method: string, params: any, sessionId?: string) {
    this.handler({ method, params, sessionId });
  }
  close() {
    this.closed = true;
    this.end();
  }
}
const session = { target: { webSocketDebuggerUrl: "ws://test" } } as Session;
afterEach(() => vi.restoreAllMocks());
async function arm() {
  const w = new Wire();
  vi.spyOn(Connection, "open").mockResolvedValue(w as any);
  const opening = Observer.open(session);
  await new Promise((r) => setTimeout(r, 0));
  return { w, opening };
}
const pushed = (over: any = {}) =>
  "3:::" +
  JSON.stringify({
    body: JSON.stringify({
      type: "NewMessage",
      resourceType: "NewMessage",
      resource: {
        id: "123",
        conversationLink: "/v1/users/ME/conversations/48:notes",
        messagetype: "RichText/Html",
        content: "hello",
        ...over,
      },
    }),
  });
describe("observer lifecycle", () => {
  it("does not declare readiness before workers acknowledge and resume", async () => {
    const { w, opening } = await arm();
    let ready = false;
    void opening.then(() => {
      ready = true;
    });
    expect(ready).toBe(false);
    w.workerReady!();
    const o = await opening;
    expect(w.calls).toEqual([
      "page:Network.enable",
      "page:Target.setAutoAttach",
      "worker:Network.enable",
      "worker:Target.setAutoAttach",
      "worker:Runtime.runIfWaitingForDebugger",
    ]);
    await o.close();
    expect(w.closed).toBe(true);
  });
  it("buffers arrivals during setup and exposes only selected response identities", async () => {
    const { w, opening } = await arm();
    w.emit(
      "Network.webSocketFrameReceived",
      { response: { opcode: 1, payloadData: pushed() } },
      "worker",
    );
    w.workerReady!();
    const o = await opening;
    expect(o.snapshot()[0].messageId).toBe("123");
    w.emit(
      "Network.requestWillBeSent",
      {
        requestId: "1",
        request: {
          url: "https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/conversations/48%3Anotes/messages?token=SECRET",
          method: "POST",
          headers: { Authorization: "SECRET" },
          postData: JSON.stringify({ clientmessageid: "77", token: "SECRET" }),
        },
      },
      "worker",
    );
    w.emit(
      "Network.responseReceived",
      {
        requestId: "1",
        response: {
          status: 201,
          headers: {
            authorization: "SECRET",
            location:
              "https://server/v1/users/ME/conversations/48:notes/messages/456?sig=SECRET",
          },
        },
      },
      "worker",
    );
    const ack = o.snapshot()[1];
    expect(ack).toMatchObject({
      kind: "send-ack",
      messageId: "456",
      clientMessageId: "77",
      status: 201,
    });
    expect(JSON.stringify(o.snapshot())).not.toContain("SECRET");
    await o.close();
  });
  it("does not correlate equal request ids from different worker sessions", async () => {
    const { w, opening } = await arm();
    w.workerReady!();
    const o = await opening;
    w.emit(
      "Network.requestWillBeSent",
      {
        requestId: "1",
        request: {
          url: "https://teams.cloud.microsoft/api/chatsvc/a/v1/users/ME/conversations/48:notes/messages",
          method: "POST",
        },
      },
      "a",
    );
    w.emit(
      "Network.responseReceived",
      { requestId: "1", response: { status: 201, headers: {} } },
      "b",
    );
    expect(o.snapshot()).toEqual([]);
    await o.close();
  });
  it("wakes pending waits on disconnect and never treats loss as a quiet timeout", async () => {
    const { w, opening } = await arm();
    w.workerReady!();
    const o = await opening;
    const waiting = o.wait(10000);
    w.end();
    await expect(waiting).rejects.toMatchObject({ code: "OBSERVATION_LOST" });
    await o.close();
  });
  it("reports overflow instead of silently dropping events", async () => {
    const w = new Wire();
    vi.spyOn(Connection, "open").mockResolvedValue(w as any);
    const opening = Observer.open(session, 1);
    await new Promise((r) => setTimeout(r, 0));
    w.workerReady!();
    const o = await opening;
    for (let i = 0; i < 2; i++)
      w.emit("Network.webSocketFrameReceived", {
        response: { opcode: 1, payloadData: pushed() },
      });
    expect(() => o.snapshot()).toThrow("buffer filled");
    await o.close();
  });
});
it("decodes observed Socket.IO resource envelopes, ignores unrelated/auth payloads", () => {
  expect(
    decodePush(
      pushed({ token: "SECRET", properties: { accessToken: "SECRET" } }),
    )[0],
  ).toMatchObject({ kind: "message", messageId: "123", content: "hello" });
  expect(JSON.stringify(decodePush(pushed({ token: "SECRET" })))).not.toContain(
    "SECRET",
  );
  expect(decodePush("~")).toEqual([]);
  expect(decodePush('3:::{"token":"SECRET"}')).toEqual([]);
  expect(
    decodePush(pushed({ messagetype: "Control/Typing", id: undefined }))[0]
      .kind,
  ).toBe("typing");
});
it("does not retain location query, userinfo or unrelated URL ids", () => {
  expect(
    messageAddress(
      "https://u:p@server/v1/conversations/48%3Anotes/messages/99?token=SECRET",
    ),
  ).toEqual({ conversationId: "48:notes", messageId: "99" });
  expect(
    messageAddress("https://server/oauth/token?conversation=48:notes"),
  ).toEqual({});
});

it("reports loss of a recognized push socket without confusing another worker's socket id", async () => {
  const { w, opening } = await arm(); w.workerReady!(); const o = await opening;
  w.emit("Network.webSocketFrameReceived", { requestId: "socket", response: { opcode: 1, payloadData: pushed() } }, "worker");
  w.emit("Network.webSocketClosed", { requestId: "socket" }, "other");
  expect(() => o.assertHealthy()).not.toThrow();
  w.emit("Network.webSocketClosed", { requestId: "socket" }, "worker");
  expect(() => o.assertHealthy()).toThrow("push socket was lost"); await o.close();
});


it("reads only completed selected calendar responses, with scope from before navigation", async () => {
  const w=new Wire();vi.spyOn(Connection,"open").mockResolvedValue(w as any);
  const opening=Observer.open(session,2000,{calendar:true,allowTargetExit:true});
  await new Promise(r=>setTimeout(r,0));w.workerReady!();const o=await opening;
  const url="https://outlook.office.com/owa/service.svc?action=GetCalendarView";
  const scope={Body:{CalendarId:{BaseFolderId:{Id:"calendar"}},RangeStart:"2026-09-21T00:00:00",RangeEnd:"2026-09-26T00:00:00"},Header:{TimeZoneContext:{TimeZoneDefinition:{Id:"UTC"}}}};
  const request={url,headers:{authorization:"SECRET","x-owa-urlpostdata":encodeURIComponent(JSON.stringify(scope))}};
  w.emit("Network.requestWillBeSent",{requestId:"c",request},"worker");
  w.emit("Network.responseReceived",{requestId:"c",response:{url,status:200,headers:{authorization:"SECRET"}}},"worker");
  expect(w.bodyReads).toEqual([]);
  w.responseBody={Body:{ResponseClass:"Success",ResponseCode:"NoError",Items:[]},token:"SECRET"};
  w.emit("Network.loadingFinished",{requestId:"c",encodedDataLength:150},"worker");
  await new Promise(r=>setTimeout(r,0));
  expect(w.bodyReads).toEqual(["c"]);expect(o.snapshot()[0].calendar).toMatchObject({calendarId:"calendar",items:[]});
  expect(JSON.stringify(o.snapshot())).not.toContain("SECRET");
  w.emit("Network.requestWillBeSent",{requestId:"auth",request:{url:"https://outlook.office.com/owa/service.svc?action=GetAccessTokenforResource"}},"worker");
  w.emit("Network.loadingFinished",{requestId:"auth",encodedDataLength:100},"worker");
  expect(w.bodyReads).toEqual(["c"]);await o.close();
});
it("allows expected frame exits for view snapshots but still fails connection loss", async()=>{
  const w=new Wire();vi.spyOn(Connection,"open").mockResolvedValue(w as any);const opening=Observer.open(session,2000,{allowTargetExit:true});
  await new Promise(r=>setTimeout(r,0));w.workerReady!();const o=await opening;
  w.emit("Target.detachedFromTarget",{sessionId:"worker"});expect(()=>o.assertHealthy()).not.toThrow();
  w.end();expect(()=>o.assertHealthy()).toThrow("connection was lost");await o.close();
});

async function fileObserver() {
  const info = { index: 1, id: "file-id", name: "file.md", type: "md", origin: "https://tenant.sharepoint.com", path: "/file.md" };
  const w = new Wire(); vi.spyOn(Connection, "open").mockResolvedValue(w as any);
  const opening = Observer.open(session, 2000, { attachment: { info, maxBytes: 1024 }, allowTargetExit: true });
  await new Promise(r => setTimeout(r, 0)); w.workerReady!(); const o = await opening;
  return { w, o, url: info.origin + "/personal/user/_layouts/15/download.aspx?UniqueId=file-id" };
}
it("captures the selected complete file only after loading, never a thumbnail or a neighbour", async () => {
  const { w, o, url } = await fileObserver();
  for (const [requestId, target] of [["thumb", url.replace("download.aspx", "thumbnail")], ["other", url.replace("file-id", "other-id")], ["selected", url]]) {
    w.emit("Network.responseReceived", { requestId, response: { url: target, status: 200, mimeType: "application/octet-stream" } }, "worker");
  }
  expect(o.attachment()).toBeUndefined(); expect(w.bodyReads).toEqual([]);
  w.rawBody = { body: Buffer.from("ação\r\n").toString("base64"), base64Encoded: true };
  for (const requestId of ["thumb", "other", "selected"]) w.emit("Network.loadingFinished", { requestId, encodedDataLength: 10 }, "worker");
  await new Promise(r => setTimeout(r, 0));
  expect(w.bodyReads).toEqual(["selected"]); expect(o.attachment()?.bytes).toEqual(Buffer.from("ação\r\n"));
  await o.close(); expect(w.closed).toBe(true);
});
it.each([206, 302, 401, 500])("does not claim a complete file for HTTP %s", async status => {
  const { w, o, url } = await fileObserver();
  w.emit("Network.responseReceived", { requestId: "file", response: { url, status } }, "worker");
  expect(() => o.attachment()).toThrow("did not load completely"); expect(w.bodyReads).toEqual([]); await o.close();
});
it("enforces decoded byte limits even when transport size is small", async () => {
  const { w, o, url } = await fileObserver();
  w.rawBody = { body: "x".repeat(1025), base64Encoded: false };
  w.emit("Network.responseReceived", { requestId: "file", response: { url, status: 200 } }, "worker");
  w.emit("Network.loadingFinished", { requestId: "file", encodedDataLength: 20 }, "worker");
  await new Promise(r => setTimeout(r, 0)); expect(() => o.attachment()).toThrow("max-bytes"); await o.close();
});
