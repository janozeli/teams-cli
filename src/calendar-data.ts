import { CliError } from "./errors.js";

export interface CalendarScope { calendarId: string; start: string; end: string; timeZone: string }
export interface CalendarEntry {
  id: string; subject: string; start: string; end: string;
  allDay: boolean; cancelled: boolean; location?: string; organizer?: string;
}
export interface CalendarView extends CalendarScope { items: CalendarEntry[]; observedAt: number }
const text = (v: unknown, max = 4096): string | undefined => typeof v === "string" && v.length <= max ? v : undefined;
const date = (v: unknown): string | undefined => {
  const s = text(v, 80);
  return s && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)) ? s : undefined;
};
export function isCalendarViewUrl(value: unknown): boolean {
  try {
    const u = new URL(String(value));
    return u.origin === "https://outlook.office.com" && u.pathname === "/owa/service.svc" && u.searchParams.get("action") === "GetCalendarView";
  } catch { return false; }
}

/** Extract just the calendar scope from Outlook's business-data header/body. */
export function calendarScope(request: { postData?: unknown; headers?: Record<string, unknown> }): CalendarScope {
  const payload = request.postData ?? Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === "x-owa-urlpostdata")?.[1];
  if (typeof payload !== "string" || payload.length > 1024 * 1024) throw new CliError("Calendar request scope is unavailable", "CALENDAR_SCHEMA_CHANGED");
  let value: any;
  try { value = JSON.parse(payload.startsWith("{") ? payload : decodeURIComponent(payload)); }
  catch { throw new CliError("Calendar request scope is unreadable", "CALENDAR_SCHEMA_CHANGED"); }
  const body = value?.Body;
  const start = date(body?.RangeStart), end = date(body?.RangeEnd);
  const calendarId = text(body?.CalendarId?.BaseFolderId?.Id ?? body?.CalendarId?.Id ?? body?.CalendarId);
  const timeZone = text(value?.Header?.TimeZoneContext?.TimeZoneDefinition?.Id, 128);
  if (!start || !end || !calendarId || !timeZone || Date.parse(end) <= Date.parse(start)) throw new CliError("Calendar request range or identity changed", "CALENDAR_SCHEMA_CHANGED");
  return { calendarId, start, end, timeZone };
}

/** Only calendar fields leave this projection; unrelated Outlook responses never enter it. */
export function calendarView(value: any, scope: CalendarScope, observedAt = Date.now()): CalendarView {
  const body = value?.Body;
  if (body?.ResponseClass !== "Success" || body?.ResponseCode !== "NoError") throw new CliError("Teams did not receive a successful calendar view", "CALENDAR_UNAVAILABLE");
  if (!Array.isArray(body.Items)) throw new CliError("Calendar response has no item list", "CALENDAR_SCHEMA_CHANGED");
  if (body.Items.length > 10000) throw new CliError("Calendar response exceeds the item limit", "OBSERVATION_OVERFLOW");
  const items = body.Items.map((item: any): CalendarEntry => {
    const id = text(item?.ItemId?.Id), subject = text(item?.Subject);
    const start = date(item?.Start), end = date(item?.End);
    if (!id || subject === undefined || !start || !end) throw new CliError("Calendar item layout changed", "CALENDAR_SCHEMA_CHANGED");
    return { id, subject, start, end, allDay: item.IsAllDayEvent === true, cancelled: item.IsCancelled === true,
      location: text(typeof item.Location === "string" ? item.Location : item.Location?.DisplayName),
      organizer: text(item.Organizer?.Mailbox?.Name),
    };
  });
  return { ...scope, items, observedAt };
}
