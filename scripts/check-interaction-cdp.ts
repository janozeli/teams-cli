/** Coordinated live test: explicit synthetic CDP inputs, only inside the activity view. */
import assert from "node:assert/strict";
import { openSession } from "../src/cdp.js";
import { withLock } from "../src/lock.js";
import { uiLockPath } from "../src/audit.js";
import { InteractionSession, currentOperation, withOperation, withUiControl } from "../src/operation.js";
import { readTrace } from "../src/trace.js";
import type { UiController } from "../src/ui-controller.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const session = await openSession();
const results: unknown[] = [];
const owner = new InteractionSession();

async function stimulate(source: string): Promise<unknown> {
  // Called outside the owner's AsyncLocalStorage scope, as an independent CDP client.
  return session.run(`(() => {
    const host = document.querySelector('#teams-cli-activity-view');
    if (!host?.shadowRoot) throw Error('Activity view is not mounted');
    const panel = host.shadowRoot.querySelector('[data-panel]');
    ${source}
    return true;
  })()`);
}
async function begin(name: string) {
  let ready!: (ui: UiController) => void, failed!: (error: unknown) => void;
  const armed = new Promise<UiController>((resolve, reject) => { ready = resolve; failed = reject; });
  const operation = withOperation(name, () => withLock(uiLockPath(), () => withUiControl(session, async () => {
    const ui = currentOperation()!.ui!; ready(ui);
    const deadline = performance.now() + 60000;
    while (!ui.gate.interrupted) {
      ui.assertHealthy();
      if (performance.now() >= deadline) throw Error('Controlled test did not receive its stimulus');
      await sleep(25);
    }
    // Deliberately attempt one harmless step to prove it is rejected before dispatch.
    await session.run('true', undefined, 'interaction.blocked.probe');
    throw Error('Barrier unexpectedly allowed the pending probe');
  })), owner);
  void operation.catch(failed);
  return { ui: await armed, operation };
}
async function finish(run: Awaited<ReturnType<typeof begin>>, expected: string, reason?: string) {
  const result: any = await run.operation;
  assert.equal(result.status, expected);
  assert.equal(result.pendingStepsWillExecute, false);
  const trace = readTrace(result.trace.id);
  assert.deepEqual(trace.issues, []);
  assert.ok(trace.events.some(e => e.event === 'step.not.executed'));
  assert.ok(!trace.events.some(e => e.event === 'step.dispatch.requested'));
  if (reason) assert.ok(trace.events.some(e => e.event === 'gate.released' && e.data.reason === reason));
  assert.equal(await session.run("!!document.querySelector('#teams-cli-activity-view')"), expected !== 'cancelled');
  results.push({ scenario: expected === 'cancelled' ? 'cancel' : reason, trace: result.trace, validated: true, pendingProbeDispatched: false, overlayRemoved: expected === 'cancelled' });
}

let active: Awaited<ReturnType<typeof begin>> | undefined;
try {
  active = await begin('interaction-check.cdp.resume');
  await stimulate("panel.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, composed:true }));");
  await sleep(350); assert.equal(active.ui.gate.state, 'open');
  process.stdout.write('PASS: pointer movement over the view did not start waiting.\n');
  await stimulate("panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, composed:true }));");
  await sleep(350); assert.equal(active.ui.gate.state, 'open');
  await stimulate("host.shadowRoot.querySelector('[data-action=pause]').click();");
  await sleep(350); assert.equal(active.ui.gate.state, 'waiting');
  await stimulate("panel.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, composed:true }));");
  await sleep(1000); assert.equal(active.ui.gate.state, 'waiting');
  process.stdout.write('PASS: ordinary input stayed active; only Pause started waiting.\n');
  await stimulate("host.shadowRoot.querySelector('[data-action=resume]').click();");
  await finish(active, 'interrupted', 'resume'); active = undefined;
  process.stdout.write('PASS: Resume ended waiting without dispatching the pending probe.\n');

  active = await begin('interaction-check.cdp.cancel');
  await sleep(2000);
  await stimulate("host.shadowRoot.querySelector('[data-action=cancel]').click();");
  await finish(active, 'cancelled'); active = undefined;
  process.stdout.write('PASS: Cancel ended the operation and removed the view.\n');

  process.stdout.write(JSON.stringify({ status: 'passed', inputSource: 'Controlled synthetic CDP events, not physical human input', results }, null, 2) + '\n');
  process.exitCode = 0;
} catch (error) {
  if (active) {
    await stimulate("host.shadowRoot.querySelector('[data-action=cancel]').click();").catch(() => {});
    await active.operation.catch(() => {});
  }
  process.stderr.write(JSON.stringify({ status: 'failed', message: (error as Error).message, results }) + '\n');
  process.exitCode = 1;
}

await owner.end();
