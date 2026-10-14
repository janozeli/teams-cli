import { afterEach, describe, expect, it } from "vitest";
import { PageError, webSocketTransport, type Target } from "../src/cdp.js";

const target: Target = { id: "t", type: "page", title: "Teams", url: "https://teams.cloud.microsoft/", webSocketDebuggerUrl: "ws://fake" };

type Behavior = (ws: FakeWebSocket, sent: string) => void;
class FakeWebSocket {
  static behavior: Behavior = () => {};
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    FakeWebSocket.behavior(this, data);
  }
  close() {
    this.closed = true;
  }
}

const original = globalThis.WebSocket;
const use = (b: Behavior) => {
  FakeWebSocket.behavior = b;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
};
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = original;
});

const reply = (ws: FakeWebSocket, body: unknown) => queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(body) }));

describe("webSocketTransport", () => {
  it("returns the evaluated value and closes the socket", async () => {
    use((ws, sent) => reply(ws, { id: JSON.parse(sent).id, result: { result: { value: 42 } } }));
    await expect(webSocketTransport(target, "1", 1000)).resolves.toBe(42);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  it("maps coded page exceptions to PageError", async () => {
    use((ws) => reply(ws, { id: 1, result: { exceptionDetails: { exception: { description: "Error: TEAMS_CLI:WRONG_CHAT:not the target\n at x" } } } }));
    const err = await webSocketTransport(target, "1", 1000).catch((e) => e);
    expect(err).toBeInstanceOf(PageError);
    expect(err).toMatchObject({ code: "WRONG_CHAT", message: "not the target" });
  });

  it("maps other exceptions to PAGE_SCRIPT_ERROR", async () => {
    use((ws) => reply(ws, { id: 1, result: { exceptionDetails: { exception: { description: "TypeError: boom" } } } }));
    await expect(webSocketTransport(target, "1", 1000)).rejects.toMatchObject({ code: "PAGE_SCRIPT_ERROR" });
  });

  it("rejects malformed frames instead of throwing out of the callback", async () => {
    use((ws) => queueMicrotask(() => ws.onmessage?.({ data: "{not json" })));
    await expect(webSocketTransport(target, "1", 1000)).rejects.toMatchObject({ code: "CDP_ERROR" });
  });

  it("rejects promptly when the socket closes without answering", async () => {
    use((ws) => queueMicrotask(() => ws.onclose?.()));
    const started = Date.now();
    await expect(webSocketTransport(target, "1", 5000)).rejects.toMatchObject({ code: "CDP_ERROR" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("times out and ignores late answers", async () => {
    use((ws) => setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ id: 1, result: { result: { value: 1 } } }) }), 100));
    await expect(webSocketTransport(target, "1", 20)).rejects.toMatchObject({ code: "CDP_TIMEOUT" });
  });

  it("ignores frames for other ids (events) and waits for its own", async () => {
    use((ws) => {
      reply(ws, { method: "Runtime.consoleAPICalled", params: {} });
      reply(ws, { id: 1, result: { result: { value: "ok" } } });
    });
    await expect(webSocketTransport(target, "1", 1000)).resolves.toBe("ok");
  });
});
