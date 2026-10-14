import { instrumentSession } from "./operation.js";
import * as pageScripts from "./page/scripts.js";
import { CliError } from "./errors.js";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export function cdpUrl(): string {
  return (process.env.TEAMS_CLI_CDP_URL || DEFAULT_CDP_URL).replace(/\/+$/, "");
}

export interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

const UNREACHABLE_HELP = [
  "Start teams-for-linux with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`",
  "Or point TEAMS_CLI_CDP_URL at the CDP endpoint (e.g. http://127.0.0.1:9222)",
];

export async function listTargets(): Promise<Target[]> {
  let res: Response;
  try {
    res = await fetch(`${cdpUrl()}/json/list`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new CliError(`CDP endpoint not reachable at ${cdpUrl()}`, "CDP_UNREACHABLE", UNREACHABLE_HELP);
  }
  if (!res.ok) {
    throw new CliError(`CDP endpoint answered HTTP ${res.status} at ${cdpUrl()}/json/list`, "CDP_UNREACHABLE", UNREACHABLE_HELP);
  }
  return (await res.json()) as Target[];
}

const TEAMS_PAGE = /^https:\/\/teams\.(cloud\.microsoft|microsoft\.com)\//;

/** The main Teams web page; the hidden IncomingCallToast window is ignored. */
export async function teamsTarget(): Promise<Target> {
  const pages = (await listTargets()).filter((t) => t.type === "page" && TEAMS_PAGE.test(t.url));
  if (pages.length === 0) {
    throw new CliError("No Teams page found among CDP targets", "TARGET_NOT_FOUND", [
      "Make sure Teams is signed in and its main window has finished loading",
    ]);
  }
  if (pages.length > 1) {
    throw new CliError(`${pages.length} Teams pages are open; refusing to guess which one to drive`, "TARGET_AMBIGUOUS", [
      "Close the extra Teams windows, or point TEAMS_CLI_CDP_URL at a single instance",
    ]);
  }
  return pages[0];
}

/** Evaluates a JS expression in the page and returns its JSON value. */
export type Transport = <T>(target: Target, source: string, timeoutMs: number) => Promise<T>;
/** Sends one raw CDP command and returns its result object. */
export type CdpCall = (target: Target, method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

/** Default transport: one WebSocket per call, nothing persists between calls. */
export const webSocketTransport: Transport = <T>(target: Target, source: string, timeoutMs: number) =>
  webSocketCall(target, "Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true }, timeoutMs).then((result) => {
    const r = result as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (r.exceptionDetails) throw pageError(r.exceptionDetails);
    return r.result?.value as T;
  });

export const webSocketCall: CdpCall = (target, method, params, timeoutMs) =>
  new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new CliError(`CDP call timed out after ${timeoutMs}ms`, "CDP_TIMEOUT"))),
      timeoutMs,
    );
    ws.onerror = () => settle(() => reject(new CliError("CDP WebSocket connection failed", "CDP_UNREACHABLE", UNREACHABLE_HELP)));
    ws.onclose = () => settle(() => reject(new CliError("CDP WebSocket closed before answering", "CDP_ERROR")));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      let msg: { id?: number; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return settle(() => reject(new CliError("CDP sent a malformed frame", "CDP_ERROR")));
      }
      if (msg.id !== 1) return;
      settle(() => {
        if (msg.error) return reject(new CliError(`CDP error: ${msg.error.message ?? "unknown"}`, "CDP_ERROR"));
        if (!msg.result) return reject(new CliError("CDP response had no result", "CDP_ERROR"));
        resolve(msg.result);
      });
    };
  });

/** Map a page exception; page scripts signal expected failures as `TEAMS_CLI:<CODE>:<message>`. */
export function pageError(details: unknown): CliError {
  const d = details as { exception?: { description?: string }; text?: string };
  const text = d.exception?.description ?? d.text ?? "unknown exception";
  const coded = /TEAMS_CLI:([A-Z_]+):([^\n]*)/.exec(text);
  if (coded) return new PageError(coded[2], coded[1]);
  return new CliError(`Page script failed: ${text.split("\n")[0]}`, "PAGE_SCRIPT_ERROR");
}

/** An explicitly coded page exception. Interruption may follow partial effects. */
export class PageError extends CliError {}

let transport: Transport = webSocketTransport;
let cdpCall: CdpCall = webSocketCall;

/** Tests swap the transport; production uses the WebSocket one. */
export function setTransport(t: Transport, call?: CdpCall): void {
  transport = t;
  if (call) cdpCall = call;
}

/** A command's connection: one target, resolved once, used for every step. */
export interface Session {
  target: Target;
  run<T>(source: string, timeoutMs?: number, label?: string): Promise<T>;
  /** Raw CDP command (e.g. Input.insertText) on the same target. */
  cdp(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

let targetResolver: () => Promise<Target> = teamsTarget;

export function setTargetResolver(r: () => Promise<Target>): void {
  targetResolver = r;
}

export async function openSession(): Promise<Session> {
  const target = await targetResolver();
  return instrumentSession({
    target,
    run: (source, timeoutMs = 20000) => transport(target, source, timeoutMs),
    cdp: (method, params = {}, timeoutMs = 10000) => cdpCall(target, method, params, timeoutMs),
  });
}

/** Build an expression that runs `body` (the source of an async function taking `args`) with JSON args. */
export function script(body: string, args: Record<string, unknown>): string {
  const account = process.env.TEAMS_CLI_ACCOUNT;
  const name = Object.entries(pageScripts).find(([, source]) => source === body)?.[0];
  return `(${body})(${JSON.stringify(account ? { ...args, account } : args)})${name ? `/*axi:${name}*/` : ""}`;
}
