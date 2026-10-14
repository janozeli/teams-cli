import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "./errors.js";

const STALE_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process mutex (O_EXCL lock file). Sends are serialized so two invocations
 * never interleave on the one Teams composer. A lock left by a dead process, or
 * invalid and older than a minute, is taken over. A living holder never expires.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const pid = Number(readFileSync(path, "utf8"));
        const validPid = Number.isInteger(pid) && pid > 0;
        stale = validPid ? !alive(pid) : Date.now() - statSync(path).mtimeMs > STALE_MS;
      } catch {
        stale = true; // vanished or unreadable between checks; retry
      }
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError("Another teams-cli UI operation is in progress", "BUSY", ["Retry once the other UI operation finishes"]);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
