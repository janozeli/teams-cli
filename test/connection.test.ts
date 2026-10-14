import { afterEach, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
const original = globalThis.WebSocket;
class Socket {
  static last: Socket;
  onopen: any;
  onmessage: any;
  onerror: any;
  onclose: any;
  sent: any[] = [];
  closed = false;
  constructor(_: string) {
    Socket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
  }
  reply(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
afterEach(() => {
  globalThis.WebSocket = original;
});
async function open() {
  globalThis.WebSocket = Socket as any;
  return Connection.open("ws://test");
}
it("correlates out-of-order replies across worker sessions and retains events", async () => {
  const c = await open();
  const events: any[] = [];
  c.onEvent((e) => events.push(e));
  const one = c.call("Network.enable", {}, "w1");
  const two = c.call("Network.enable", {}, "w2");
  expect(Socket.last.sent.map((x) => x.sessionId)).toEqual(["w1", "w2"]);
  Socket.last.reply({
    method: "Network.loadingFinished",
    sessionId: "w1",
    params: { requestId: "r" },
  });
  Socket.last.reply({ id: 2, result: { second: true } });
  Socket.last.reply({ id: 1, result: { first: true } });
  expect(await two).toEqual({ second: true });
  expect(await one).toEqual({ first: true });
  expect(events[0].sessionId).toBe("w1");
  c.close();
});
it("rejects all in-flight calls on disconnect and releases timers", async () => {
  const c = await open();
  const one = c.call("A").catch((e) => e.code);
  const two = c.call("B").catch((e) => e.code);
  Socket.last.onclose();
  expect(await one).toBe("CDP_ERROR");
  expect(await two).toBe("CDP_ERROR");
  await expect(c.call("C")).rejects.toMatchObject({ code: "CDP_ERROR" });
  expect(Socket.last.closed).toBe(true);
});
it("does not expose remote error bodies and can continue after one command fails", async () => {
  const c = await open();
  const one = c.call("A").catch((e) => e.message);
  Socket.last.reply({ id: 1, error: { message: "secret bearer payload" } });
  expect(await one).toBe("CDP command failed");
  const two = c.call("B");
  Socket.last.reply({ id: 2, result: {} });
  await two;
  c.close();
});
it("times out one request, ignores its late response, and closes on malformed events", async () => {
  const c = await open();
  await expect(c.call("A", {}, undefined, 5)).rejects.toMatchObject({
    code: "CDP_TIMEOUT",
  });
  Socket.last.reply({ id: 1, result: {} });
  const next = c.call("B").catch((e) => e.code);
  Socket.last.onmessage({ data: "not-json" });
  expect(await next).toBe("CDP_ERROR");
  expect(Socket.last.closed).toBe(true);
});
