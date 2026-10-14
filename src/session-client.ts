import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import { cdpUrl } from "./cdp.js";
import { withLock } from "./lock.js";
import { dispatchCommand } from "./command-dispatch.js";

export function sessionSocketPath(): string {
  const dir = join(tmpdir(), `teams-cli-${process.getuid?.() ?? "local"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077))
    throw new CliError("Session socket directory must be private and owned by this user", "SESSION_UNAVAILABLE");
  const key = createHash("sha256").update(JSON.stringify([cdpUrl(), process.env.TEAMS_CLI_ACCOUNT, process.env.XDG_STATE_HOME, fileURLToPath(new URL(".", import.meta.url))])).digest("hex").slice(0, 20);
  return join(dir, key + ".sock");
}
async function connect(path: string) {
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  return new Promise<typeof socket>((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(new Error("Session connection timeout")), 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.removeListener("error", fail); resolve(socket); });
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    socket.once("error", fail);
  });
}
function absent(error: unknown): boolean { return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""); }
async function ensureConnection(path: string) {
  try { return await connect(path); } catch (error) { if (!absent(error)) throw error; }
  // Only connection establishment is retried. Requests are never replayed.
  return withLock(path + ".start", async () => {
    try { return await connect(path); } catch (error) { if (!absent(error)) throw error; }
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./session-worker.ts" : "./session-worker.js", import.meta.url));
    const child = spawn(process.execPath, [...(source ? ["--import", "tsx"] : []), entry, path], { detached: true, stdio: "ignore", env: process.env });
    let failed: Error | undefined; child.once("error", error => { failed = error; }); child.unref();
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (failed || child.exitCode !== null) break;
      try { return await connect(path); } catch (error) { if (!absent(error)) throw error; }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new CliError("Could not start the interaction session", "SESSION_UNAVAILABLE");
  });
}
export async function sessionRequest(request: Record<string, unknown>, start = false): Promise<any> {
  const path = sessionSocketPath();
  let socket;
  try { socket = start ? await ensureConnection(path) : await connect(path); }
  catch (error) { if (!start && absent(error)) return { status: "inactive" }; throw error; }
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const fail = () => {
      if (settled) return;
      settled = true; socket.destroy();
      reject(new CliError("Session connection lost. Inspect the trace and Teams before issuing another command; this request was not replayed", "SESSION_CONNECTION_LOST"));
    };
    socket.on("error", fail); socket.on("close", fail);
    socket.on("data", bytes => {
      buffer += bytes.toString();
      if (buffer.length > 32 * 1024 * 1024) { fail(); return; }
      let split: number;
      while ((split = buffer.indexOf("\n")) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, split)); } catch { fail(); return; }
        buffer = buffer.slice(split + 1);
        if (message.notice) { process.stderr.write(message.notice); continue; }
        settled = true; socket.end();
        if (message.error) reject(Object.assign(new CliError(message.error.message, message.error.code, message.error.suggestions), { trace: message.error.trace }));
        else { if (message.exitCode) process.exitCode = message.exitCode; resolve(message.result); }
      }
    });
    socket.write(JSON.stringify(request) + "\n");
  });
}
export async function runSessionCommand(command: string, args: string[] = []) {
  let stdin: string | undefined;
  if ((command === "send" || command === "edit") && args.some(arg => arg === "--stdin" || arg === "--stdin=true")) {
    const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    stdin = Buffer.concat(chunks).toString("utf8");
  }
  const request = { type: "command", command, args, stdin };
  const existing = await sessionRequest(request);
  if (existing?.status !== "inactive") return existing;
  const needsUi = ["send", "edit", "react", "calendar", "attachments"].includes(command) && !args.includes("--dry-run");
  return needsUi ? sessionRequest(request, true) : dispatchCommand(command, args, undefined, stdin);
}
export async function sessionCommand(args: string[]) {
  if (args.length !== 1 || !["status", "end"].includes(args[0])) throw new CliError("Use teams-cli session status or teams-cli session end", "VALIDATION_ERROR");
  return sessionRequest({ type: args[0] });
}
