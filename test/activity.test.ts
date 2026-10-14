import { describe, expect, it } from "vitest";
import type { Session } from "../src/cdp.js";
import { activityLabel, guardUserActivity } from "../src/commands.js";

describe("activityLabel", () => {
  it("names feed item types", () => {
    expect(activityLabel("mention", "channel")).toBe("mention (channel)");
    expect(activityLabel("reaction", "heart")).toBe("reaction ❤️");
    expect(activityLabel("replyToReply", "")).toBe("reply (to your reply)");
    expect(activityLabel("reply", "")).toBe("reply");
  });
});

describe("guardUserActivity", () => {
  const session = (state: object) => ({ run: async () => state }) as unknown as Session;
  it("refuses while Teams is focused with a draft, unless forced", async () => {
    await expect(guardUserActivity(session({ focused: true, draft: true }), false)).rejects.toMatchObject({ code: "USER_ACTIVE" });
    await expect(guardUserActivity(session({ focused: true, draft: true }), true)).resolves.toBeUndefined();
  });
  it("lets it through when the window is not focused or there is no draft", async () => {
    await expect(guardUserActivity(session({ focused: false, draft: true }), false)).resolves.toBeUndefined();
    await expect(guardUserActivity(session({ focused: true, draft: false }), false)).resolves.toBeUndefined();
  });
});
