import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { instrumentSession } from "../../src/operation.js";
import { webSocketCall, webSocketTransport, type Session, type Target } from "../../src/cdp.js";

/** Dedicated headless process/profile. No desktop pointer, keyboard, Teams or account. */
export async function isolatedBrowser() {
  const directory = mkdtempSync(join(tmpdir(), "teams-cli-browser-"));
  let child: ChildProcess | undefined, browser: Browser | undefined, launchError: Error | undefined;
  const close = async () => {
    await browser?.close().catch(() => {});
    if (child?.pid) {
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child!.once("exit", () => resolve()));
      // This detached process group contains only this fixture's Chromium children.
      // Closing a CDP client alone can leave a network service writing the profile.
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    child = spawn(chromium.executablePath(), ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { stdio: "ignore", detached: true });
    child.on("error", error => { launchError = error; });
    let port = "";
    const deadline = performance.now() + 15000;
    while (!port && performance.now() < deadline) {
      try { port = readFileSync(join(directory, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await new Promise(r => setTimeout(r, 50)); }
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error("Headless Chromium exited before CDP was ready");
    }
    if (!port) throw Error("Run npx playwright install chromium before browser tests");
    const endpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(endpoint);
    return {
      async page(): Promise<{ page: Page; session: Session }> {
        const page = await browser!.contexts()[0].newPage();
        await page.setContent('<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for \'script\'"><main><button id="app-button">App action</button><input id="draft"><div style="height:2000px">Fixture only</div></main>');
        const client = await page.context().newCDPSession(page);
        const { targetInfo } = await client.send("Target.getTargetInfo"); await client.detach();
        const targets: Target[] = await (await fetch(endpoint + "/json/list")).json();
        const target = targets.find(t => t.id === targetInfo.targetId)!;
        const session = instrumentSession({ target, run: (source, ms = 20000) => webSocketTransport(target, source, ms), cdp: (method, params = {}, ms = 10000) => webSocketCall(target, method, params, ms) });
        return { page, session };
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
