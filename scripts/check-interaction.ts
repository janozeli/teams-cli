/** Run only during an agreed joint test. Mounts the view; performs no Teams action. */
import { renderOutput } from "../src/output.js";
import { openSession } from "../src/cdp.js";
import { withLock } from "../src/lock.js";
import { uiLockPath } from "../src/audit.js";
import { InteractionSession, currentOperation, withOperation, withUiControl } from "../src/operation.js";

const owner = new InteractionSession();
process.on("SIGINT", () => { void owner.end(); });
const result = await withOperation("interaction-check", async () => {
  const session = await openSession();
  return withLock(uiLockPath(), () => withUiControl(session, async () => {
    process.stderr.write("Joint check ready in Teams. Ordinary interaction must not pause. Click Pause; after 30s idle the view counts down 10s. Resume releases early and keeps this view; Cancel ends the session. No Teams message will be sent.\n");
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      currentOperation()!.ui!.assertAllowed();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { status: "no_interruption_observed", note: "The check ended after 60 seconds without interruption. This does not verify the interaction behavior." };
  }));
}, owner).catch(error => {
  process.exitCode = 1;
  return { status: "failed", code: error.code ?? "UNKNOWN", message: error.message, details: error.suggestions ?? [] };
});
process.stdout.write((typeof result === "string" ? result : renderOutput(result as Record<string, unknown>)) + "\n");

if (owner.ui && !owner.ended && typeof result !== "string" && result.status === "interrupted") {
  process.stderr.write("The command returned interrupted; the same view and trace remain. Click Cancel to finish this joint check.\n");
  while (!owner.ended) await new Promise(resolve => setTimeout(resolve, 250));
}
await owner.end();
