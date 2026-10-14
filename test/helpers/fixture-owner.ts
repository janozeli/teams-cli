import { serveSession } from "../../src/session-worker.js";
import { withOperation, withUiControl, instrumentSession } from "../../src/operation.js";
import { webSocketTransport, webSocketCall } from "../../src/cdp.js";
import { PRELUDE } from "../../src/page/scripts.js";
const target = JSON.parse(process.env.FIXTURE_TARGET!);
const session = instrumentSession({ target, run: (source, ms = 20000) => webSocketTransport(target, source, ms), cdp: (method, params = {}, ms = 10000) => webSocketCall(target, method, params, ms) });
const worker = await serveSession(process.argv[2], (command, _args, owner) => withOperation(command, () => withUiControl(session, async () => {
  if (command === "hold") {
    await session.run(`(async () => { ${PRELUDE} globalThis.started = (globalThis.started || 0) + 1; await sleep(1500); act('late', () => globalThis.forbidden = true); return true; })()`);
  }
  return { value: await session.run("40 + 2") };
}), owner));
process.on("SIGTERM", () => { void worker.stop(); });
console.log("ready");
