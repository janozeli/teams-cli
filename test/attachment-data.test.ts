import { expect, it } from "vitest";
import { attachmentText, isAttachmentContentUrl, loadedAttachment, type AttachmentInfo } from "../src/attachment-data.js";

const info: AttachmentInfo = { index: 1, id: "abc-123", name: "report.md", type: "md", origin: "https://tenant.sharepoint.com", path: "/documents/report.md" };
const url = info.origin + "/personal/user/_layouts/15/download.aspx?UniqueId=ABC-123&token=secret";
it("selects complete file responses by origin and id, excluding thumbnails and other files", () => {
  expect(isAttachmentContentUrl(url, info)).toBe(true);
  for (const other of [url.replace("ABC-123", "different"), url.replace("tenant.", "other."), url.replace("download.aspx", "embed.aspx"), info.origin + "/thumbnails/0/content", "invalid"])
    expect(isAttachmentContentUrl(other, info)).toBe(false);
});
it("preserves complete binary bytes and refuses text interpretation of binary files", () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const file = loadedAttachment({ ...info, type: "pdf" }, "application/pdf", bytes.toString("base64"), true, 5);
  expect(file.bytes).toEqual(bytes);
  expect(attachmentText(file)).toBeNull();
});
it("reads UTF-8 by file type when the server uses octet-stream", () => {
  const file = loadedAttachment(info, "application/octet-stream", "ação 🎉\r\n", false, 100);
  expect(attachmentText(file)).toBe("ação 🎉\r\n");
  expect(attachmentText({ ...file, bytes: Buffer.from([255]) })).toBeNull();
});
it("does not present oversized files or HTML login pages as file contents", () => {
  expect(() => loadedAttachment(info, "text/plain", "1234", false, 3)).toThrow("max-bytes");
  expect(() => loadedAttachment(info, "text/html", "<html>login</html>", false, 100)).toThrow("HTML page");
});
