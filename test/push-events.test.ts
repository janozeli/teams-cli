import { expect, it } from "vitest";
import { deflateSync, gzipSync } from "node:zlib";
import { decodePush } from "../src/observation.js";
const frame = (body: unknown) => "3:::" + JSON.stringify({ body: JSON.stringify(body), headers: { authorization: "SECRET" } });
it("projects single and batched UPS presence without notes, calendar details or credentials", () => {
  const presence = { mri: "8:orgid:person", etag: "version1", presence: { availability: "Busy", activity: "InACall", statusNote: "PRIVATE", calendarData: { subject: "PRIVATE" } } };
  const one = decodePush(frame({ presence }), 42);
  expect(one).toEqual([{ kind: "presence", at: 42, senderId: "8:orgid:person", state: "Busy", activity: "InACall", version: "version1", change: "presence" }]);
  expect(decodePush(frame({ presence: [presence, { ...presence, mri: "8:orgid:other" }] }))).toHaveLength(2);
  expect(JSON.stringify(one)).not.toMatch(/PRIVATE|SECRET/);
  expect(decodePush(frame({ presence: { mri: "invalid", presence: {} } }))).toEqual([]);
});
it("recognizes exact typing records with direct conversation ids and keeps their arrival identity", () => {
  const event = { resourceType: "NewMessage", resource: { conversationid: "19:thread@thread.v2", messagetype: "Control/Typing", from: "https://host/v1/users/ME/contacts/8:orgid:person", originalarrivaltime: "2026-09-24T10:00:00Z" } };
  expect(decodePush(frame(event))[0]).toMatchObject({ kind: "typing", conversationId: "19:thread@thread.v2", senderId: "8:orgid:person", state: "typing", version: "2026-09-24T10:00:00Z" });
  expect(decodePush(frame({ ...event, resourceType: "UnrelatedTypingThing" }))).toEqual([]);
});
const call = { callNotification: { from: { id: "8:orgid:person", displayName: "Person" }, callType: "incoming", links: { accept: "SECRET" } }, debugContent: { callId: "call-123", participantId: "PRIVATE" }, groupChat: { threadId: "19:call@thread.v2" }, credentials: "SECRET" };
it.each(["object", "base64", "compressed", "gzip"])("decodes incoming call %s and strips signaling links", (encoding) => {
  const payload = JSON.stringify(call);
  const body = encoding === "object" ? { gp: call } : encoding === "base64" ? { gp: Buffer.from(payload).toString("base64") } : { cp: (encoding === "gzip" ? gzipSync(payload) : deflateSync(payload)).toString("base64") };
  const events = decodePush(frame({ evt: 107, ...body }), 42);
  expect(events).toEqual([{ kind: "call", at: 42, callId: "call-123", eventId: 107, state: "incoming", change: "incoming", conversationId: "19:call@thread.v2", senderId: "8:orgid:person", senderName: "Person" }]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET/);
});
it("does not mistake call-history messages or meeting-start pushes for incoming calls", () => {
  expect(decodePush(frame({ evt: 128, gp: call }))).toEqual([]);
  expect(decodePush(frame({ resourceType: "NewMessage", resource: { id: "123", conversationid: "48:notes", messagetype: "Event/Call", content: "history" } }))[0].kind).toBe("message");
});
it("reports corrupt known call payloads and bounds compressed expansion", () => {
  expect(() => decodePush(frame({ evt: 107, cp: "bad" }))).toThrow("could not be decoded");
  const cp = deflateSync(Buffer.from(" ".repeat(3 * 1024 * 1024))).toString("base64");
  expect(() => decodePush(frame({ evt: 107, cp }))).toThrow("could not be decoded");
  expect(decodePush(frame({ annotationType: "unrelated", ops: [{ token: "SECRET" }] }))).toEqual([]);
});
