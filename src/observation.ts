import { recordOperationEvent } from "./operation.js";
import { unzipSync } from "node:zlib";
import { CliError } from "./errors.js";
import { Connection, type ProtocolEvent } from "./connection.js";
import { pageError, type Session } from "./cdp.js";
import { isAttachmentContentUrl, loadedAttachment, type AttachmentInfo, type LoadedAttachment } from "./attachment-data.js";
import { calendarScope, calendarView, isCalendarViewUrl, type CalendarScope, type CalendarView } from "./calendar-data.js";

export type EventKind =
  | "message"
  | "typing"
  | "presence"
  | "call"
  | "send-ack"
  | "calendar"
  | "attachment";
export interface ObservedEvent {
  kind: EventKind;
  at: number;
  conversationId?: string;
  messageId?: string;
  clientMessageId?: string;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  change?: string;
  content?: string;
  version?: string;
  status?: number;
  state?: string;
  activity?: string;
  callId?: string;
  eventId?: number;
  calendar?: CalendarView;
}
export interface Observation {
  /** Snapshot retains events observed during the caller's cache-baseline read. */
  snapshot(): ObservedEvent[];
  /** Wakes on an event, loss/failure, or timeout; callers inspect their predicate again. */
  wait(ms: number): Promise<void>;
  assertHealthy(): void;
  close(): Promise<void>;
}

const MAX_FRAME = 2 * 1024 * 1024;
const field = (value: unknown, max = 512): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;
const numericId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[1-9]\d{0,30}$/.test(value)
    ? value
    : undefined;
const conversationId = (value: unknown): string | undefined =>
  typeof value === "string" && /^(19:|48:)[^\s/?#]{1,500}$/.test(value) ? value : undefined;
const actorId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const direct = /^(8:[^\s/?#]{1,160})$/.exec(value);
  if (direct) return direct[1];
  try {
    return /\/contacts\/(8:[^/]+)$/.exec(new URL(value).pathname)?.[1];
  } catch {
    return undefined;
  }
};

/** Read only the conversation/message path components, never retain URL queries. */
export function messageAddress(value: unknown): {
  conversationId?: string;
  messageId?: string;
} {
  if (typeof value !== "string") return {};
  try {
    const path = new URL(value, "https://teams.cloud.microsoft").pathname;
    const m = /\/conversations\/([^/]+)(?:\/messages\/([^/]+))?/.exec(path);
    if (!m) return {};
    const conversationId = decodeURIComponent(m[1]);
    if (!/^(?:19:|48:)/.test(conversationId)) return {};
    return {
      conversationId,
      messageId: numericId(m[2] && decodeURIComponent(m[2])),
    };
  } catch {
    return {};
  }
}

/** Project only known business fields from Trouter's JSON or Socket.IO 0.9 frames. */
export function decodePush(payload: string, at = Date.now()): ObservedEvent[] {
  if (payload.length > MAX_FRAME)
    throw new CliError(
      "An observed frame exceeded the parser limit",
      "OBSERVATION_OVERFLOW",
    );
  let envelope: any;
  try {
    envelope = JSON.parse(payload.replace(/^\d+::[^:]*:/, ""));
  } catch {
    return [];
  }
  let notice: any = envelope;
  if (typeof envelope?.body === "string") {
    try {
      notice = JSON.parse(envelope.body);
    } catch {
      return [];
    }
  }
  if (notice?.presence) {
    const entries = Array.isArray(notice.presence) ? notice.presence : [notice.presence];
    return entries.flatMap((entry: any): ObservedEvent[] => {
      const senderId = actorId(entry?.mri);
      const state = field(entry?.presence?.availability);
      if (!senderId || !state) return [];
      return [{ kind: "presence", at, senderId, state, activity: field(entry.presence.activity), version: field(entry.etag), change: "presence" }];
    });
  }
  // Incoming call event ids and gp/cp encodings used by the loaded calling client.
  const eventId = notice?.evt ?? notice?.eventId;
  if ([107, 109, 111, 119, 125, 126].includes(eventId)) {
    let call: any;
    try {
      if (notice.gp && typeof notice.gp === "object") call = notice.gp;
      else if (typeof notice.gp === "string") call = JSON.parse(Buffer.from(notice.gp, "base64").toString("utf8"));
      else if (typeof notice.cp === "string") call = JSON.parse(unzipSync(Buffer.from(notice.cp, "base64"), { maxOutputLength: MAX_FRAME }).toString("utf8"));
      const notification = call?.callNotification;
      const callId = field(call?.debugContent?.callId);
      if (!notification || !callId) throw Error("missing identity");
      return [{ kind: "call", at, callId, eventId, state: "incoming", change: field(notification.callType),
        conversationId: conversationId(call.groupChat?.threadId), senderId: actorId(notification.from?.id),
        senderName: field(notification.from?.displayName) }];
    } catch { throw new CliError("An incoming call notification could not be decoded", "OBSERVATION_PARSE_ERROR"); }
  }
  if (
    !notice ||
    typeof notice !== "object" ||
    !notice.resource ||
    typeof notice.resource !== "object"
  )
    return [];
  const r = notice.resource;
  const address = messageAddress(
    r.conversationLink || notice.resourceLink || r.to,
  );
  const messageType = field(r.messagetype);
  const resourceType = field(notice.resourceType);
  address.conversationId = conversationId(r.conversationid) ?? address.conversationId;
  if (!["NewMessage", "MessageUpdate", "PartialMessageUpdate"].includes(resourceType ?? "")) return [];
  const kind: EventKind | undefined = address.conversationId && messageType === "Control/Typing"
    ? "typing" : address.conversationId && numericId(r.id) ? "message" : undefined;
  if (!kind) return [];
  return [
    {
      kind,
      at,
      ...address,
      messageId: numericId(r.id) ?? address.messageId,
      clientMessageId: numericId(r.clientmessageid),
      senderId: actorId(r.from),
      senderName: field(r.imdisplayname),
      messageType,
      change: resourceType,
      version: field(String(r.version ?? r.originalarrivaltime ?? "")),
      // Ordinary message content is untrusted and fenced by the presentation layer.
      content: kind === "message" ? field(r.content, MAX_FRAME) : undefined,
      state: kind === "typing" ? "typing" : undefined,
    },
  ];
}

export interface ObservationOptions { calendar?: boolean; allowTargetExit?: boolean; attachment?: { info: AttachmentInfo; maxBytes: number } }

interface Request {
  conversationId: string;
  clientMessageId?: string;
  method: string;
}

/** Headers and raw envelopes are consumed synchronously, never queued, returned or logged. */
export class Observer implements Observation {
  private events: ObservedEvent[] = [];
  private requests = new Map<string, Request>();
  private pushSockets = new Set<string>();
  private setups = new Set<Promise<void>>();
  private sessions = new Map<string, { targetId: string; type: string; ready: boolean }>();
  private calendarRequests = new Map<string, CalendarScope>();
  private calendarResponses = new Set<string>();
  private bodies = new Set<Promise<void>>();
  private attachmentResponses = new Map<string, { mime: string }>();
  private file?: LoadedAttachment;
  private wakeups = new Set<() => void>();
  private failure?: Error;
  private closing = false;
  private removeEvent: () => void;
  private removeClose: () => void;

  private constructor(
    private connection: Connection,
    private capacity: number,
    private options: ObservationOptions,
  ) {
    this.removeEvent = connection.onEvent((event) => this.receive(event));
    this.removeClose = connection.onClose(() =>
      this.fail(
        new CliError("Observation connection was lost", "OBSERVATION_LOST"),
      ),
    );
  }

  static async open(session: Session, capacity = 2000, options: ObservationOptions = {}): Promise<Observer> {
    const c = await Connection.open(session.target.webSocketDebuggerUrl);
    const observer = new Observer(c, capacity, options);
    try {
      // Handler installed first. Auto-attach emits all existing related workers before
      // acknowledging; drain their recursive setup before declaring readiness.
      await c.call("Network.enable", observer.networkOptions());
      await c.call("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: true,
      });
      while (observer.setups.size) await Promise.all([...observer.setups]);
      observer.assertHealthy();
      return observer;
    } catch (error) {
      await observer.close();
      throw error;
    }
  }

  private networkOptions(): Record<string, number> {
    const max = this.options.attachment?.maxBytes ?? MAX_FRAME;
    return { maxPostDataSize: 1024 * 1024, maxResourceBufferSize: max, maxTotalBufferSize: max * 2 };
  }

  private fail(error: Error): void {
    if (!this.failure && !this.closing) this.failure = error;
    this.wake();
  }
  private wake(): void {
    for (const wake of this.wakeups) wake();
    this.wakeups.clear();
  }
  private add(event: ObservedEvent): void {
    if (this.events.length >= this.capacity) {
      this.fail(
        new CliError(
          "Observation buffer filled; events may be missing",
          "OBSERVATION_OVERFLOW",
        ),
      );
      return;
    }
    recordOperationEvent({ actor: "application", component: "cdp", event: "application.event.observed", evidence: "observation",
      timestamp: new Date(event.at).toISOString(), timestampSource: "observer", clockId: "host-wall-clock",
      data: { kind: event.kind }, uncertainty: { reason: "Observed while this command was active; timing alone does not establish that the command caused it" } });
    this.events.push(event);
    this.wake();
  }

  private receive(e: ProtocolEvent): void {
    if (this.closing) return;
    const p = e.params;
    if (e.method === "Target.attachedToTarget") {
      const sid = p.sessionId;
      this.sessions.set(sid, { targetId: p.targetInfo.targetId, type: p.targetInfo.type, ready: false });
      const setup = (async () => {
        try {
          await this.connection.call(
            "Network.enable",
            this.networkOptions(),
            sid,
          );
          await this.connection.call(
            "Target.setAutoAttach",
            { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
            sid,
          );
          const attached = this.sessions.get(sid);
          if (attached) attached.ready = true;
        } finally {
          // New workers are paused until their listener is ready; always release them.
          await this.connection.call(
            "Runtime.runIfWaitingForDebugger",
            {},
            sid,
          );
        }
      })();
      this.setups.add(setup);
      void setup
        .catch(() => {
          if (!this.options.allowTargetExit || this.sessions.has(sid)) this.fail(new CliError("Could not arm a related target", "OBSERVATION_LOST"));
        })
        .finally(() => this.setups.delete(setup));
      return;
    }
    if (e.method === "Target.detachedFromTarget") {
      this.sessions.delete(p.sessionId);
      for (const requests of [this.requests, this.attachmentResponses])
        for (const key of requests.keys()) if (key.startsWith(p.sessionId + ":")) requests.delete(key);
      for (const key of this.calendarRequests.keys()) if (key.startsWith(p.sessionId + ":")) {
        this.calendarRequests.delete(key); this.calendarResponses.delete(key);
      }
      if (this.options.allowTargetExit) { this.wake(); return; }
      // A destroyed worker can be replaced. Report the gap rather than claiming a
      // continuous stream (the next command can establish a fresh observation).
      this.fail(
        new CliError("An observed target detached", "OBSERVATION_LOST"),
      );
      return;
    }
    const key = `${e.sessionId ?? "page"}:${p.requestId}`;
    if ((e.method === "Network.webSocketClosed" || e.method === "Network.webSocketFrameError") && this.pushSockets.has(key)) {
      this.fail(new CliError("Teams' observed push socket was lost", "OBSERVATION_LOST"));
      return;
    }
    if (this.options.calendar) this.captureCalendar(e, key);
    if (this.options.attachment) this.captureAttachment(e, key);
    if (e.method === "Network.requestWillBeSent") {
      this.requests.delete(key); // redirects cannot retain an earlier request identity
      const request = p.request;
      if (request?.method !== "POST") return;
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return;
      }
      if (
        !/^https:\/\/teams\.(cloud\.microsoft|microsoft\.com)$/.test(
          url.origin,
        ) ||
        !/\/chatsvc\/.*\/messages$/.test(url.pathname)
      )
        return;
      const { conversationId } = messageAddress(request.url);
      if (!conversationId) return;
      if (this.requests.size >= 512) {
        this.fail(
          new CliError(
            "Too many pending observed sends",
            "OBSERVATION_OVERFLOW",
          ),
        );
        return;
      }
      let clientMessageId: string | undefined;
      if (
        typeof request.postData === "string" &&
        request.postData.length <= MAX_FRAME
      ) {
        try {
          clientMessageId = numericId(
            JSON.parse(request.postData).clientmessageid,
          );
        } catch {}
      }
      this.requests.set(key, {
        conversationId,
        clientMessageId,
        method: "POST",
      });
    } else if (e.method === "Network.responseReceived") {
      const request = this.requests.get(key);
      if (!request) return;
      this.requests.delete(key);
      const response = p.response;
      // Location is the sole selected response header; only its validated ids survive.
      const location = Object.entries(response.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "location",
      )?.[1];
      const address = messageAddress(location);
      this.add({
        kind: "send-ack",
        at: Date.now(),
        conversationId: request.conversationId,
        clientMessageId: request.clientMessageId,
        status: response.status,
        messageId:
          address.conversationId === request.conversationId
            ? address.messageId
            : undefined,
      });
    } else if (
      e.method === "Network.loadingFailed" ||
      e.method === "Network.loadingFinished"
    ) {
      this.requests.delete(key);
    } else if (
      e.method === "Network.webSocketFrameReceived" &&
      p.response?.opcode === 1
    ) {
      try {
        const events = decodePush(p.response.payloadData);
        if (events.length) this.pushSockets.add(key);
        for (const event of events) this.add(event);
      } catch (error) {
        this.fail(error instanceof CliError ? error : new CliError("An observed event could not be decoded", "OBSERVATION_PARSE_ERROR"));
      }
    } else if (e.method === "Network.eventSourceMessageReceived") {
      try {
        for (const event of decodePush(p.data)) this.add(event);
      } catch (error) {
        this.fail(error instanceof CliError ? error : new CliError("An observed event could not be decoded", "OBSERVATION_PARSE_ERROR"));
      }
    }
  }


  private captureAttachment(e: ProtocolEvent, key: string): void {
    const p = e.params;
    const { info, maxBytes } = this.options.attachment!;
    if (e.method === "Network.responseReceived") {
      const response = p.response;
      if (!isAttachmentContentUrl(response?.url, info)) return;
      if (response.status !== 200) { this.fail(new CliError("The selected attachment did not load completely", "ATTACHMENT_UNAVAILABLE")); return; }
      if (this.attachmentResponses.size >= 16) { this.fail(new CliError("Too many attachment responses", "OBSERVATION_OVERFLOW")); return; }
      this.attachmentResponses.set(key, { mime: typeof response.mimeType === "string" ? response.mimeType : "application/octet-stream" });
    } else if (e.method === "Network.loadingFailed" && this.attachmentResponses.has(key)) {
      this.attachmentResponses.delete(key); this.fail(new CliError("Attachment loading failed", "ATTACHMENT_UNAVAILABLE"));
    } else if (e.method === "Network.loadingFinished" && this.attachmentResponses.has(key)) {
      const response = this.attachmentResponses.get(key)!; this.attachmentResponses.delete(key);
      if (p.encodedDataLength > maxBytes || this.bodies.size >= 16) { this.fail(new CliError("Attachment exceeds --max-bytes", "ATTACHMENT_TOO_LARGE")); return; }
      const task = (async () => {
        try {
          const result = await this.connection.call("Network.getResponseBody", { requestId: p.requestId }, e.sessionId);
          if (result.body.length > maxBytes * (result.base64Encoded ? 1.4 : 1)) throw new CliError("Attachment exceeds --max-bytes", "ATTACHMENT_TOO_LARGE");
          this.file = loadedAttachment(info, response.mime, result.body, result.base64Encoded, maxBytes);
          this.wake();
        } catch (error) { if (!this.closing) this.fail(error instanceof CliError ? error : new CliError("The loaded attachment body is unavailable", "ATTACHMENT_UNAVAILABLE")); }
      })();
      this.bodies.add(task); void task.finally(() => this.bodies.delete(task));
    }
  }

  attachment(): LoadedAttachment | undefined { this.assertHealthy(); return this.file; }

  private captureCalendar(e: ProtocolEvent, key: string): void {
    const p = e.params;
    if (e.method === "Network.requestWillBeSent") {
      this.calendarRequests.delete(key); this.calendarResponses.delete(key);
      if (!isCalendarViewUrl(p.request?.url)) return;
      try {
        if (this.calendarRequests.size >= 32) throw new CliError("Too many pending calendar views", "OBSERVATION_OVERFLOW");
        this.calendarRequests.set(key, calendarScope(p.request));
      } catch (error) { this.fail(error as Error); }
    } else if (e.method === "Network.responseReceived" && this.calendarRequests.has(key)) {
      if (!isCalendarViewUrl(p.response?.url) || p.response.status !== 200) {
        this.fail(new CliError("Calendar view request failed", "CALENDAR_UNAVAILABLE")); return;
      }
      this.calendarResponses.add(key);
    } else if (e.method === "Network.loadingFailed" && this.calendarRequests.has(key)) {
      this.calendarRequests.delete(key); this.calendarResponses.delete(key);
      if (!this.options.allowTargetExit || !p.canceled) this.fail(new CliError("Calendar view did not finish loading", "CALENDAR_UNAVAILABLE"));
    } else if (e.method === "Network.loadingFinished" && this.calendarResponses.has(key)) {
      const scope = this.calendarRequests.get(key)!;
      this.calendarRequests.delete(key); this.calendarResponses.delete(key);
      if (p.encodedDataLength > MAX_FRAME || this.bodies.size >= 16) {
        this.fail(new CliError("Calendar response exceeds the capture limit", "OBSERVATION_OVERFLOW")); return;
      }
      const task = (async () => {
        try {
          // Reads an already completed browser response; never replays a request.
          const result = await this.connection.call("Network.getResponseBody", { requestId: p.requestId }, e.sessionId);
          if (result.body.length > MAX_FRAME * 1.4) throw new CliError("Calendar response exceeds the capture limit", "OBSERVATION_OVERFLOW");
          const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
          this.add({ kind: "calendar", at: Date.now(), calendar: calendarView(JSON.parse(body), scope) });
        } catch (error) {
          if (this.closing || (this.options.allowTargetExit && e.sessionId && !this.sessions.has(e.sessionId))) return;
          this.fail(error instanceof CliError ? error : new CliError("Calendar response could not be read", "CALENDAR_UNAVAILABLE"));
        }
      })();
      this.bodies.add(task);
      void task.finally(() => { this.bodies.delete(task); this.wake(); });
    }
  }

  get pendingCalendarViews(): number { return this.calendarRequests.size + this.bodies.size; }

  /** A related, fully armed calendar iframe, addressed on this same connection. */
  async calendarFrame(): Promise<Session | null> {
    this.assertHealthy();
    const { targetInfos } = await this.connection.call("Target.getTargets");
    const candidates = targetInfos.filter((t: any) => {
      try { const u = new URL(t.url); return t.type === "iframe" && u.origin === "https://outlook.office.com" && u.pathname.startsWith("/hosted/calendar"); } catch { return false; }
    }).flatMap((t: any) => [...this.sessions].filter(([, s]) => s.targetId === t.targetId && s.ready).map(([sid]) => ({ t, sid })));
    if (candidates.length > 1) throw new CliError("Several related calendar frames are open", "TARGET_AMBIGUOUS");
    if (!candidates.length) return null;
    const { t, sid } = candidates[0];
    return {
      target: { id: t.targetId, type: t.type, title: t.title, url: t.url, webSocketDebuggerUrl: "" },
      run: async <T>(source: string, timeoutMs = 20000): Promise<T> => {
        this.assertHealthy();
        const result = await this.connection.call("Runtime.evaluate", { expression: source, returnByValue: true, awaitPromise: true }, sid, timeoutMs);
        if (result.exceptionDetails) throw pageError(result.exceptionDetails);
        return result.result?.value as T;
      },
      cdp: (method, params = {}, timeoutMs = 10000) => this.connection.call(method, params, sid, timeoutMs),
    };
  }

  snapshot(): ObservedEvent[] {
    this.assertHealthy();
    return this.events.slice();
  }
  assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (this.closing)
      throw new CliError("Observation is closed", "OBSERVATION_LOST");
  }
  async wait(ms: number): Promise<void> {
    this.assertHealthy();
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, ms));
      this.wakeups.add(wake);
    });
    this.assertHealthy();
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.removeEvent();
    this.removeClose();
    // Detaching by closing the socket releases paused targets even if setup failed.
    this.connection.close();
    await Promise.allSettled([...this.setups, ...this.bodies]);
    this.events = [];
    this.requests.clear();
    this.pushSockets.clear();
    this.calendarRequests.clear(); this.calendarResponses.clear();
    this.attachmentResponses.clear(); this.file = undefined;
    this.sessions.clear();
    this.wake();
  }
}

export async function withObservation<T>(
  session: Session,
  action: (observer: Observation) => Promise<T>,
): Promise<T> {
  const observer = await Observer.open(session);
  try {
    return await action(observer);
  } finally {
    await observer.close();
  }
}
