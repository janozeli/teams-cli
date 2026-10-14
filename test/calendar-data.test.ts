import { describe, expect, it } from "vitest";
import { calendarScope, calendarView, isCalendarViewUrl } from "../src/calendar-data.js";
const scope = { calendarId: "calendar-1", start: "2026-09-21T00:00:00", end: "2026-09-26T00:00:00", timeZone: "E. South America Standard Time" };
const request = { Body: { CalendarId: { BaseFolderId: { Id: scope.calendarId } }, RangeStart: scope.start, RangeEnd: scope.end }, Header: { TimeZoneContext: { TimeZoneDefinition: { Id: scope.timeZone } } } };
it("selects only the observed Outlook calendar-view route", () => {
 expect(isCalendarViewUrl("https://outlook.office.com/owa/service.svc?action=GetCalendarView")).toBe(true);
 for (const url of ["https://outlook.office.com/owa/service.svc?action=GetAccessTokenforResource", "https://outlook.office.com.evil/owa/service.svc?action=GetCalendarView", "https://outlook.office.com/owa/startupdata.ashx"]) expect(isCalendarViewUrl(url)).toBe(false);
});
it("projects the business-data header into a scope without preserving credentials", () => {
 const result = calendarScope({ headers: { Authorization: "SECRET", "x-owa-urlpostdata": encodeURIComponent(JSON.stringify(request)) } });
 expect(result).toEqual(scope); expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("requires an explicit calendar id, time zone and valid range", () => {
 expect(() => calendarScope({postData:"{}"})).toThrow("range or identity");
 expect(() => calendarScope({postData:"not-json"})).toThrow("unreadable");
});
describe("calendar projection", () => {
 it("distinguishes an empty success from missing data and errors", () => {
  expect(calendarView({Body:{ResponseClass:"Success",ResponseCode:"NoError",Items:[]}},scope,1)).toEqual({...scope,items:[],observedAt:1});
  for (const body of [{ResponseClass:"Error",ResponseCode:"ErrorAccessDenied",Items:[]},{ResponseClass:"Success",ResponseCode:"NoError"}]) expect(()=>calendarView({Body:body},scope)).toThrow();
 });
 it("preserves event times and identity but selects no tokens, bodies or join links", () => {
  const v=calendarView({Body:{ResponseClass:"Success",ResponseCode:"NoError",Items:[{ItemId:{Id:"event-1",ChangeKey:"SECRET"},Subject:"Review",Start:"2026-09-24T10:00:00-03:00",End:"2026-09-24T10:30:00-03:00",IsAllDayEvent:false,Location:"Room",Organizer:{Mailbox:{Name:"Ana",EmailAddress:"not needed"}},JoinUrl:"SECRET",Body:"SECRET"}]}},scope);
  expect(v.items[0]).toEqual({id:"event-1",subject:"Review",start:"2026-09-24T10:00:00-03:00",end:"2026-09-24T10:30:00-03:00",allDay:false,cancelled:false,location:"Room",organizer:"Ana"});expect(JSON.stringify(v)).not.toContain("SECRET");
 });
 it("does not silently drop calendar items with a changed schema", () => {
  expect(()=>calendarView({Body:{ResponseClass:"Success",ResponseCode:"NoError",Items:[{Id:"new shape"}]}},scope)).toThrow("layout changed");
 });
});
