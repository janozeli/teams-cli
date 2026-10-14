import {afterEach,expect,it,vi} from "vitest";
import{readCalendar,OPEN_CALENDAR,REFRESH_CALENDAR}from"../src/calendar.js";
import{Observer}from"../src/observation.js";
import type{Session}from"../src/cdp.js";
afterEach(()=>vi.restoreAllMocks());
const view={calendarId:"c",start:"2026-09-21T00:00:00",end:"2026-09-26T00:00:00",timeZone:"UTC",items:[],observedAt:0};
function fixture(options:{busy?:boolean;empty?:boolean}={}){
 let now=2000;vi.spyOn(Date,"now").mockImplementation(()=>now);const steps:string[]=[];
 const frame={run:async(source:string)=>{expect(source).toBe(REFRESH_CALENDAR);steps.push("refresh");if(options.busy)throw Error("CALENDAR_BUSY");}};
 const observation={calendarFrame:async()=>frame,snapshot:()=>options.empty?[]:[{calendar:view}],pendingCalendarViews:0,assertHealthy:()=>{},wait:async(ms:number)=>{now+=ms;},close:async()=>{steps.push("closed");}};
 vi.spyOn(Observer,"open").mockImplementation(async()=>{steps.push("armed");return observation as any;});
 const session={run:async(source:string)=>{expect(source).toBe(OPEN_CALENDAR);steps.push("open");}} as unknown as Session;
 return{steps,promise:readCalendar(session,1000)};
}
it("arms before opening or refreshing and closes after an empty confirmed view",async()=>{
 const r=fixture();await expect(r.promise).resolves.toEqual([view]);expect(r.steps).toEqual(["armed","open","refresh","closed"]);
});
it("closes observation after refusing a calendar draft",async()=>{const r=fixture({busy:true});await expect(r.promise).rejects.toThrow("CALENDAR_BUSY");expect(r.steps.at(-1)).toBe("closed");});
it("does not equate missing responses with an empty calendar",async()=>{const r=fixture({empty:true});await expect(r.promise).rejects.toMatchObject({code:"CALENDAR_UNAVAILABLE"});expect(r.steps.at(-1)).toBe("closed");});
