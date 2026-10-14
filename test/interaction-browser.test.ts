import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedBrowser } from "./helpers/browser.js";
import { currentOperation, withOperation, withUiControl } from "../src/operation.js";
import { readTrace, traceDirectory, reconstruct } from "../src/trace.js";
import { PRELUDE } from "../src/page/scripts.js";

let browser: Awaited<ReturnType<typeof isolatedBrowser>>;
const state = mkdtempSync(join(tmpdir(), "teams-cli-interaction-"));
beforeAll(async () => { vi.stubEnv("XDG_STATE_HOME", state); browser = await isolatedBrowser(); }, 20000);
afterAll(async () => { await browser?.close(); vi.unstubAllEnvs(); rmSync(state, { recursive: true, force: true }); process.exitCode = 0; });
const view = "#teams-cli-activity-view";

it("records a read-only operation without requiring a view or recording its source", async () => {
  const { page, session } = await browser.page();
  const result: any = await withOperation("fixture.read", async () => ({ value: await session.run("'PRIVATE SCRIPT CONTENT'") }));
  expect(result.value).toBe("PRIVATE SCRIPT CONTENT");
  const trace = readTrace(result.trace.id); expect(trace.issues).toEqual([]);
  expect(JSON.stringify(trace.events)).not.toContain("PRIVATE SCRIPT CONTENT");
  expect(await page.locator(view).count()).toBe(0); await page.close();
});

it("does not mistake owned DOM/CDP input for external interaction", async () => {
  const { page, session } = await browser.page();
  const result: any = await withOperation("fixture.owned", () => withUiControl(session, async () => {
    await session.run(`(() => { ${PRELUDE} act('focus', () => document.querySelector('input').focus()); act('click', () => document.querySelector('button').click()); return true; })()`);
    await session.cdp("Input.insertText", { text: "PRIVATE TYPED VALUE" });
    await session.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    return { done: true };
  }));
  expect(result.done).toBe(true);
  const trace = readTrace(result.trace.id); expect(trace.issues).toEqual([]);
  expect(trace.events.some(e => e.event === "agent.input.correlated")).toBe(true);
  expect(JSON.stringify(trace.events)).not.toContain("PRIVATE TYPED VALUE");
  expect(await page.locator(view).count()).toBe(0); await page.close();
});

it("ordinary activity is trace-only; Pause is synchronous and stale updates cannot reopen it", async () => {
  const { page, session } = await browser.page();
  const result: any = await withOperation("fixture.pointer", () => withUiControl(session, async () => {
    const panel = page.locator(view).locator("[data-panel]");
    for (const type of ["pointermove", "pointerdown", "click", "wheel"]) await panel.dispatchEvent(type);
    await page.locator("#draft").fill("PRIVATE USER DRAFT");
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); });
    await page.waitForTimeout(300);
    expect(currentOperation()!.ui!.gate.state).toBe("open");
    expect(await session.run("42")).toBe(42);
    const blocked = await page.evaluate(() => {
      const host = document.querySelector("#teams-cli-activity-view")!;
      (host.shadowRoot!.querySelector("[data-action=pause]") as HTMLButtonElement).click();
      const g = (globalThis as any).__teamsCliGate;
      g.update({ state: "open", interrupted: false });
      try { g.act("forbidden", () => (globalThis as any).shouldNeverExecute = true); return false; } catch { return true; }
    });
    expect(blocked).toBe(true);
    await expect.poll(() => currentOperation()!.ui!.gate.state).toBe("waiting");
    await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
    await session.run("globalThis.shouldNeverExecute = true");
    return {};
  }));
  expect(result.status).toBe("interrupted");
  expect(await page.evaluate(() => (globalThis as any).shouldNeverExecute)).toBeUndefined();
  const trace = readTrace(result.trace.id); expect(trace.issues).toEqual([]);
  expect(JSON.stringify(trace.events)).not.toContain("PRIVATE USER DRAFT");
  expect(trace.events.some(e => e.event === "control.pause")).toBe(true);
  expect(trace.events.some(e => e.event === "step.not.executed")).toBe(true);
  await page.close();
});

it("stops a script between effects, waits for explicit Resume, and never dispatches its continuation", async () => {
  const { page, session } = await browser.page();
  const operation = withOperation("fixture.partial", () => withUiControl(session, async () => {
    await session.run(`(async () => { ${PRELUDE} act('fixture.first', () => globalThis.firstEffect = true); await sleep(900); act('fixture.second', () => globalThis.secondEffect = true); return true; })()`);
    await session.run("globalThis.nextStep = true"); return {};
  }));
  await page.waitForFunction(() => (globalThis as any).firstEffect);
  // Independent CDP source, trusted browser event; still not proof of human origin.
  await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
  let completed = false; void operation.then(() => { completed = true; });
  await page.waitForTimeout(1200); expect(completed).toBe(false);
  await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
  const result: any = await operation;
  expect(result.status).toBe("interrupted"); expect(result.pendingStepsWillExecute).toBe(false);
  expect(await page.evaluate(() => [(globalThis as any).firstEffect, (globalThis as any).secondEffect, (globalThis as any).nextStep])).toEqual([true, undefined, undefined]);
  const trace = readTrace(result.trace.id); expect(trace.issues).toEqual([]);
  expect(reconstruct(trace.events).steps.some(s => s.outcome === "unknown")).toBe(true);
  expect(reconstruct(trace.events).lastConfirmedAction?.action).toBe("fixture.first");
  expect(trace.events.filter(e => e.event === "input.observed").every(e => e.actor === "unknown")).toBe(true);
  expect(await page.locator(view).count()).toBe(0); await page.close();
}, 15000);

it("Cancel terminates pending work and never performs cleanup mutations", async () => {
  const { page, session } = await browser.page();
  const operation = withOperation("fixture.cancel", () => withUiControl(session, async () => {
    await session.run(`(async () => { ${PRELUDE} globalThis.started = true; await sleep(600); act('fixture.late', () => globalThis.late = true); })()`);
    return {};
  }));
  await page.waitForFunction(() => (globalThis as any).started);
  await page.locator(view).getByRole("button", { name: "Cancel" }).click();
  const result: any = await operation;
  expect(result.status).toBe("cancelled"); expect(await page.evaluate(() => (globalThis as any).late)).toBeUndefined();
  expect(readTrace(result.trace.id).issues).toEqual([]); expect(await page.locator(view).count()).toBe(0); await page.close();
});

it("observes input in child documents and keeps the gate after navigation", async () => {
  const { page, session } = await browser.page();
  const result: any = await withOperation("fixture.documents", () => withUiControl(session, async () => {
    await page.goto("data:text/html,<main><iframe srcdoc='<input id=draft>'></iframe></main>");
    await page.waitForFunction(() => !!(globalThis as any).__teamsCliGate);
    const child = page.frames().find(f => f !== page.mainFrame())!;
    await child.waitForFunction(() => !!(globalThis as any).__teamsCliGate);
    await child.locator("input").dispatchEvent("input");
    await page.waitForTimeout(300);
    expect(currentOperation()!.ui!.gate.state).toBe("open");
    expect(await page.locator(view).count()).toBe(1);
    expect(await child.locator(view).count()).toBe(0);
    await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
    await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
    return {};
  }));
  expect(result.status).toBe("interrupted"); expect(readTrace(result.trace.id).issues).toEqual([]); await page.close();
});

it("keeps independent read-only recovery possible while an owner waits, and rejects a second owner", async () => {
  const { page, session } = await browser.page();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const owner = withOperation("fixture.owner", () => withUiControl(session, async () => { await hold; return {}; }));
  await page.locator(view).waitFor();
  await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
  const reader: any = await withOperation("fixture.reader", async () => ({ value: await session.run("42") }));
  expect(reader.value).toBe(42);
  await expect(withOperation("fixture.contender", () => withUiControl(session, async () => ({})))).rejects.toMatchObject({ code: "UI_BUSY" });
  await page.waitForTimeout(300);
  await page.locator(view).getByRole("button", { name: "Cancel" }).click();
  release(); expect((await owner as any).status).toBe("cancelled");
  expect(readTrace(reader.trace.id).issues).toEqual([]); await page.close();
});

it("uses the approved bar, SVG controls and cursor at agent targets without following user input", async () => {
  const { page, session } = await browser.page();
  await page.setViewportSize({ width: 900, height: 650 });
  await page.locator("#app-button").evaluate(el => { el.setAttribute("style", "position:fixed;left:200px;top:200px;width:100px;height:40px"); });
  const result: any = await withOperation("fixture.visual", () => withUiControl(session, async () => {
    const root = page.locator(view), cursor = root.locator("[data-cursor]"), panel = root.locator("[data-panel]");
    expect(await root.getByRole("button", { name: "Pause", exact: true }).locator("svg").count()).toBe(1);
    expect(await root.getByRole("button", { name: "Cancel", exact: true }).locator("svg").count()).toBe(1);
    expect(await cursor.isVisible()).toBe(false);
    await session.run(`(() => { ${PRELUDE} const el=document.querySelector('#app-button'); act('click',()=>el.click(),el); return true; })()`);
    expect(await cursor.isVisible()).toBe(true);
    expect(await cursor.evaluate(el => [el.style.left, el.style.top])).toEqual(["244px", "214px"]);
    await page.mouse.move(450, 400);
    expect(await cursor.evaluate(el => [el.style.left, el.style.top])).toEqual(["244px", "214px"]);
    await session.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 310, y: 320 });
    expect(await cursor.evaluate(el => [el.style.left, el.style.top])).toEqual(["304px", "314px"]);
    const frame = root.locator("[data-frame]");
    expect(await frame.evaluate(el => getComputedStyle(el).borderWidth)).toBe("0px");
    expect(await frame.evaluate(el => getComputedStyle(el).animationDuration)).toBe("4s");
    expect(await root.locator("[data-dot]").evaluate(el => getComputedStyle(el).animationDuration)).toBe("3s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await frame.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    expect(await root.locator("[data-dot]").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await page.setViewportSize({ width: 380, height: 650 });
    await expect.poll(async () => (await frame.boundingBox())!.y).toBe((await panel.boundingBox())!.height);
    const pauseBox = (await root.getByRole("button", { name: "Pause", exact: true }).boundingBox())!;
    const cancelBox = (await root.getByRole("button", { name: "Cancel", exact: true }).boundingBox())!;
    expect(cancelBox.x).toBeGreaterThan(pauseBox.x + pauseBox.width);
    expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(380);
    await root.getByRole("button", { name: "Pause", exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await cursor.isVisible()).toBe(false);
    await expect.poll(() => currentOperation()!.ui!.gate.state).toBe("waiting");
    expect(await frame.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    expect(await root.getByRole("button", { name: "Resume", exact: true }).locator("svg").count()).toBe(1);
    await page.keyboard.press("Enter"); // Pause moved keyboard focus to Resume.
    return {};
  }));
  expect(result.status).toBe("interrupted"); expect(readTrace(result.trace.id).issues).toEqual([]);
  await page.close();
});

it("preserves Pause across navigation and requires a fresh operation after Resume", async () => {
  const { page, session } = await browser.page();
  const first: any = await withOperation("fixture.navigate-paused", () => withUiControl(session, async () => {
    await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => currentOperation()!.ui!.gate.state).toBe("waiting");
    await page.goto("data:text/html,<main>New document while paused</main>");
    await page.locator(view).getByRole("button", { name: "Resume", exact: true }).waitFor();
    expect(currentOperation()!.ui!.gate.state).toBe("waiting");
    await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
    return {};
  }));
  expect(first.status).toBe("interrupted");
  const second: any = await withOperation("fixture.fresh", () => withUiControl(session, async () => ({ value: await session.run("21 * 2") })));
  expect(second.value).toBe(42); expect(second.trace.id).not.toBe(first.trace.id);
  expect(readTrace(first.trace.id).issues).toEqual([]); expect(readTrace(second.trace.id).issues).toEqual([]);
  await page.close();
});

it("keeps one view/journal across commands and permanently invalidates captured guards after Resume", async () => {
  const { InteractionSession } = await import("../src/operation.js");
  const owner = new InteractionSession();
  const { page, session } = await browser.page();
  try {
    const first: any = await withOperation("fixture.session-a", () => withUiControl(session, async () => {
      await session.run(`(() => { ${PRELUDE} globalThis.oldGuard = activityGuard; globalThis.originalView = document.querySelector('#teams-cli-activity-view'); return true; })()`);
      await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => owner.ui!.gate.state).toBe("waiting");
      await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
      await session.run("globalThis.mustNotExecute = true"); return {};
    }), owner);
    expect(first.status).toBe("interrupted"); expect(await page.locator(view).count()).toBe(1);
    await expect.poll(() => page.locator(view).getAttribute("data-state")).toBe("open");
    const before = readTrace(first.trace.id).events.length;
    await page.locator("#draft").dispatchEvent("input");
    await expect.poll(() => readTrace(first.trace.id).events.length).toBeGreaterThan(before);
    const second: any = await withOperation("fixture.session-b", () => withUiControl(session, async () => {
      expect(await page.evaluate(() => {
        try { (globalThis as any).oldGuard.act("stale", () => (globalThis as any).mustNotExecute = true); return false; } catch { return true; }
      })).toBe(true);
      return { value: await session.run("21 * 2") };
    }), owner);
    expect(second.value).toBe(42); expect(second.trace.id).toBe(first.trace.id);
    expect(await page.evaluate(() => document.querySelector("#teams-cli-activity-view") === (globalThis as any).originalView)).toBe(true);
    expect(await page.evaluate(() => (globalThis as any).mustNotExecute)).toBeUndefined();
    const trace = readTrace(first.trace.id); expect(trace.issues).toEqual([]);
    expect(new Set(trace.events.filter(e => e.event === "command.received").map(e => e.commandId)).size).toBe(2);
    await owner.end(); expect(await page.locator(view).count()).toBe(0);
    expect(readTrace(first.trace.id).events.at(-1)?.event).toBe("session.ended");
  } finally { await owner.end(); await page.close(); }
});

it("shows only the 10s countdown after 30s idle, cancels it on input, then keeps the session on expiry", async () => {
  const { InteractionSession } = await import("../src/operation.js");
  const owner = new InteractionSession(); const { page, session } = await browser.page();
  let clock = 0;
  try {
    const result: any = await withOperation("fixture.countdown", () => withUiControl(session, async () => {
      (owner.ui!.gate as any).now = () => clock;
      const root = page.locator(view), status = root.locator("[data-status]");
      await root.getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => owner.ui!.gate.phase).toBe("idle");
      expect(await status.textContent()).toBe("Paused · You’re in control");
      clock = 30000;
      await expect.poll(() => status.textContent()).toBe("Resuming in 10s");
      expect(owner.ui!.gate.idleTimeMs).toBeNull();
      clock = 35000; await expect.poll(() => status.textContent()).toBe("Resuming in 5s");
      await page.locator("#draft").dispatchEvent("input");
      await expect.poll(() => owner.ui!.gate.phase).toBe("idle");
      expect(await status.textContent()).toBe("Paused · You’re in control");
      clock = 64999; await page.waitForTimeout(300); expect(owner.ui!.gate.phase).toBe("idle");
      clock = 65000; await expect.poll(() => status.textContent()).toBe("Resuming in 10s");
      clock = 75000; await expect.poll(() => owner.ui!.gate.state).toBe("released");
      await session.run("globalThis.forbiddenAfterExpiry = true"); return {};
    }), owner);
    expect(result.status).toBe("interrupted"); expect(owner.ui!.gate.releaseReason).toBe("countdown");
    expect(await page.locator(view).count()).toBe(1);
    const next: any = await withOperation("fixture.after-countdown", () => withUiControl(session, async () => ({ value: await session.run("42") })), owner);
    expect(next.value).toBe(42); expect(next.trace.id).toBe(result.trace.id);
    expect(await page.evaluate(() => (globalThis as any).forbiddenAfterExpiry)).toBeUndefined();
    expect(readTrace(result.trace.id).issues).toEqual([]);
    // A call submitted while an idle session is paused waits, then is rejected rather than queued.
    await page.locator(view).getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => owner.ui!.gate.state).toBe("waiting");
    const notices: string[] = []; owner.notice = line => { notices.push(line); };
    let executed = false;
    const blocked = withOperation("fixture.submitted-while-paused", async () => { executed = true; return {}; }, owner);
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]).toContain("will not execute");
    await page.locator(view).getByRole("button", { name: "Resume", exact: true }).click();
    expect((await blocked as any).status).toBe("interrupted"); expect(executed).toBe(false);
    // Cancel between commands still cleans up the owner and journal.
    await page.locator(view).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => page.locator(view).count()).toBe(0);
    await expect.poll(() => readTrace(result.trace.id).events.at(-1)?.event).toBe("session.ended");
  } finally { await owner.end(); await page.close(); }
}, 15000);
