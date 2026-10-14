import { CliError } from "./errors.js";
import { currentOperation, instrumentSession } from "./operation.js";
import type { Session } from "./cdp.js";
import type { CalendarView } from "./calendar-data.js";
import { Observer } from "./observation.js";

export const OPEN_CALENDAR = `(() => {
  const app = document.getElementById('ef56c0de-36fc-4ef8-b417-3d82ba9d073c');
  if (!app || !app.closest('[data-tid=app-bar-wrapper]')) throw Error('TEAMS_CLI:NOT_REACHABLE:Calendar is not in the Teams app bar');
  const g = globalThis.__teamsCliGate;
  if (g && !g.closed) g.act("click", () => app.click(), app); else app.click();
  return true;
})()`;
export const REFRESH_CALENDAR = `(() => {
  if (location.origin !== 'https://outlook.office.com' || !location.pathname.startsWith('/hosted/calendar')) throw Error('TEAMS_CLI:WRONG_VIEW:The frame is no longer the calendar');
  const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  if ([...document.querySelectorAll('[role=dialog], [contenteditable=true]')].some(visible)) throw Error('TEAMS_CLI:CALENDAR_BUSY:Close the calendar dialog or finish the event draft before refreshing');
  const g = globalThis.__teamsCliGate && !globalThis.__teamsCliGate.closed ? globalThis.__teamsCliGate : null;
  return new Promise((resolve, reject) => setTimeout(() => {
    try { if (g) g.act("reload", () => location.reload()); else location.reload(); resolve(true); } catch (error) { reject(error); }
  }, 50));
})()`;

/** Load the app's current calendar view, retaining only responses it produces. */
export async function readCalendar(session: Session, timeoutMs = 20000): Promise<CalendarView[]> {
  const observer = await Observer.open(session, 2000, { calendar: true, allowTargetExit: true });
  const deadline = Date.now() + timeoutMs;
  try {
    const existing = await observer.calendarFrame();
    await session.run(OPEN_CALENDAR, undefined, "calendar.open");
    if (existing) await instrumentSession(existing).run(REFRESH_CALENDAR, undefined, "calendar.refresh");
    let refreshed = !!existing;
    let frameSeenAt: number | null = null;
    for (;;) {
      currentOperation()?.ui?.assertAllowed();
      observer.assertHealthy();
      const views = observer.snapshot().flatMap((event) => event.calendar ? [event.calendar] : []);
      const last = views.at(-1)?.observedAt ?? 0;
      // Wait for the response set to settle, including concurrent selected calendars.
      if (views.length && !observer.pendingCalendarViews && Date.now() - last >= 1000) {
        const latest = new Map<string, CalendarView>();
        for (const view of views) latest.set(JSON.stringify([view.calendarId, view.start, view.end]), view);
        return [...latest.values()];
      }
      if (Date.now() >= deadline) throw new CliError("No complete calendar view was observed before the timeout", "CALENDAR_UNAVAILABLE", ["Open Calendar in Teams and check that it loads; no observed response is not an empty calendar"]);
      if (!refreshed && !views.length) {
        const frame = await observer.calendarFrame();
        if (frame) {
          frameSeenAt ??= Date.now();
          // A warmed iframe can render without requesting a new view. Refresh only
          // that app frame after its listeners are ready; refuse any visible draft.
          if (Date.now() - frameSeenAt >= 1500 && !observer.pendingCalendarViews) {
            await instrumentSession(frame).run(REFRESH_CALENDAR, undefined, "calendar.refresh"); refreshed = true;
          }
        }
      }
      await observer.wait(Math.min(250, Math.max(0, deadline - Date.now())));
    }
  } finally { await observer.close(); }
}
