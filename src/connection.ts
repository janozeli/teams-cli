import { CliError } from "./errors.js";

export interface ProtocolEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/** One command-scoped, multiplexed CDP connection. No reconnect/replay of writes. */
export class Connection {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: ProtocolEvent) => void>();
  private closedListeners = new Set<(error: Error) => void>();
  private failure?: Error;

  private constructor(private ws: WebSocket) {}

  static async open(url: string, timeoutMs = 5000): Promise<Connection> {
    const ws = new WebSocket(url);
    const connection = new Connection(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(new CliError("CDP connection timed out", "CDP_TIMEOUT"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        clearTimeout(timer);
        const error = new CliError("CDP connection closed", "CDP_ERROR");
        connection.stop(error);
        reject(error);
      };
      ws.onerror = fail;
      ws.onclose = fail;
      ws.onmessage = (event) => connection.receive(String(event.data));
    });
    return connection;
  }

  onEvent(listener: (event: ProtocolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError(`CDP ${method} timed out`, "CDP_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CliError("Could not write to CDP connection", "CDP_ERROR"));
      }
    });
  }

  private receive(data: string): void {
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      this.stop(new CliError("CDP sent a malformed frame", "CDP_ERROR"));
      return;
    }
    if (!message || typeof message !== "object") {
      this.stop(new CliError("CDP sent an invalid frame", "CDP_ERROR"));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      // Never interpolate a remote error payload (it may include request details).
      if (message.error || !("result" in message))
        pending.reject(new CliError("CDP command failed", "CDP_ERROR"));
      else pending.resolve(message.result);
    } else if (
      typeof message.method === "string" &&
      message.params &&
      typeof message.params === "object"
    ) {
      try {
        for (const listener of this.listeners) listener(message);
      } catch {
        this.stop(new CliError("CDP event processing failed", "CDP_ERROR"));
      }
    }
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closedListeners) listener(error);
    this.listeners.clear();
    this.closedListeners.clear();
    this.ws.onopen =
      this.ws.onmessage =
      this.ws.onerror =
      this.ws.onclose =
        null;
    this.ws.close();
  }

  close(): void {
    this.stop(new CliError("CDP connection closed", "CDP_CLOSED"));
  }
}
