import { createServer, type Socket } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { CliError } from "./errors.js";
import { InteractionSession } from "./operation.js";
import { dispatchCommand } from "./command-dispatch.js";

/** Private local session owner. No scheduled tasks, reconnect or write replay. */
export async function serveSession(path: string, dispatch = dispatchCommand) {
  const owner = new InteractionSession();
  const sockets = new Set<Socket>();
  let closing = false, claimed = false;
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "", received = false;
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (received) return;
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      received = true;
      void handle(buffer.slice(0, buffer.indexOf("\n")), socket);
    });
  });
  async function handle(raw: string, socket: Socket) {
    let running = false, replied = false;
    const send = (message: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
    const disconnect = () => { if (running && !replied) void owner.end("client-disconnected"); };
    socket.once("close", disconnect);
    try {
      const req = JSON.parse(raw);
      if (req.type === "status") send({ result: { status: owner.ended ? "ended" : "active", busy: owner.busy, view: !!owner.ui,
        phase: owner.ui?.gate.phase ?? owner.ui?.gate.state ?? "unmounted", trace: owner.trace.reference() } });
      else if (req.type === "end") { await owner.end(); send({ result: { status: "ended", trace: owner.trace.reference() } }); }
      else if (req.type === "command") {
        if (claimed || closing || owner.ended) throw new CliError("Session is busy or ending; no command was queued", "UI_BUSY");
        if (typeof req.command !== "string" || !Array.isArray(req.args) || !req.args.every((x: unknown) => typeof x === "string") || (req.stdin !== undefined && typeof req.stdin !== "string")) throw new CliError("Invalid session request", "VALIDATION_ERROR");
        claimed = running = true; process.exitCode = 0;
        owner.notice = line => send({ notice: line });
        const result = await dispatch(req.command, req.args, owner, req.stdin);
        send({ result, exitCode: process.exitCode ?? 0 });
      } else throw new CliError("Invalid session request", "VALIDATION_ERROR");
    } catch (error) {
      const e = error instanceof CliError ? error : new CliError("Session request failed", "COMMAND_FAILED");
      send({ error: { message: e.message, code: e.code, trace: e.trace ?? owner.trace.reference(), suggestions: [...e.suggestions, `Inspect: teams-cli trace ${owner.trace.operationId}`] } });
    } finally {
      replied = true;
      if (running) { claimed = false; owner.notice = () => {}; }
      socket.end();
      // Cache-only calls do not leave an observer/process behind.
      if (!owner.busy && (owner.ended || (running && !owner.ui))) await stop();
    }
  }
  async function stop() {
    if (closing) return;
    closing = true; clearInterval(sweep); clearTimeout(unclaimed);
    await owner.end("owner-exit");
    server.close();
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const socket of sockets) socket.end();
  }
  const sweep = setInterval(() => { if (owner.ended && !owner.busy) void stop(); }, 250);
  const unclaimed = setTimeout(() => { if (!owner.ui && !claimed) void stop(); }, 15000);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { chmodSync(path, 0o600); resolve(); }); });
  return { owner, stop };
}
if (process.argv[1] && /session-worker\.(ts|js)$/.test(process.argv[1])) {
  const worker = await serveSession(process.argv[2]);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void worker.owner.end(signal); });
}
