import { describe, expect, it } from "vitest";
import { PRELUDE } from "../src/page/scripts.js";

// Evaluate the page prelude outside the browser; pickDatabase itself touches no DOM.
const pickDatabase = new Function("args", `${PRELUDE}\nreturn pickDatabase;`)({}) as (
  kind: string,
  names: string[],
  active: string | null,
  lang: string,
  override?: string,
) => { name: string; account: string; locale: string };

const db = (tenant: string, user: string, locale: string, kind = "conversation-manager") => `Teams:${kind}:react-web-client:${tenant}:${user}:${locale}`;
const names = [db("T", "A", "en-us"), db("T", "A", "pt-br"), db("T", "B", "pt-br"), db("T", "A", "pt-br", "replychain-manager")];

describe("pickDatabase", () => {
  it("prefers the signed-in account and the UI locale", () => {
    expect(pickDatabase("conversation-manager", names, "T:A", "pt-br").name).toBe(db("T", "A", "pt-br"));
    expect(pickDatabase("conversation-manager", names, "T:A", "en-US").name).toBe(db("T", "A", "en-us"));
  });

  it("falls back to another locale of the same account, never to another account", () => {
    expect(pickDatabase("conversation-manager", names, "T:B", "en-us").name).toBe(db("T", "B", "pt-br"));
  });

  it("refuses to guess between accounts when the signed-in one is unknown", () => {
    expect(() => pickDatabase("conversation-manager", names, null, "pt-br")).toThrow(/TEAMS_CLI:ACCOUNT_AMBIGUOUS/);
    expect(pickDatabase("replychain-manager", names, null, "pt-br").account).toBe("T:A"); // only one account cached
  });

  it("honours an explicit override and reports a missing account", () => {
    expect(pickDatabase("conversation-manager", names, "T:A", "pt-br", "T:B").account).toBe("T:B");
    expect(() => pickDatabase("replychain-manager", names, "T:B", "pt-br")).toThrow(/TEAMS_CLI:CACHE_UNAVAILABLE:No 'replychain-manager' cache for account T:B/);
  });
});
