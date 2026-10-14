import { CliError } from "./errors.js";

export interface AttachmentInfo {
  index: number; id: string | null; name: string; type: string;
  origin: string | null; path: string | null;
}
export interface LoadedAttachment { info: AttachmentInfo; mime: string; bytes: Buffer }
const guid = (s: string) => s.replace(/^\{|\}$/g, "").toLowerCase();

/** Select the full file response by its origin and SharePoint unique id, never by name. */
export function isAttachmentContentUrl(value: unknown, info: AttachmentInfo): boolean {
  if (!info.id || !info.origin) return false;
  try {
    const u = new URL(String(value));
    if (u.origin !== info.origin || !u.pathname.endsWith("/_layouts/15/download.aspx")) return false;
    const id = [...u.searchParams].find(([key]) => key.toLowerCase() === "uniqueid")?.[1];
    return !!id && guid(id) === guid(info.id);
  } catch { return false; }
}
export function loadedAttachment(info: AttachmentInfo, mime: string, body: string, base64Encoded: boolean, maxBytes: number): LoadedAttachment {
  const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
  if (bytes.length > maxBytes) throw new CliError("The loaded attachment exceeds --max-bytes", "ATTACHMENT_TOO_LARGE");
  if (mime.split(";")[0].trim().toLowerCase() === "text/html" && !/^(html?|xhtml)$/i.test(info.type)) throw new CliError("Teams received an HTML page instead of the selected file", "ATTACHMENT_UNAVAILABLE");
  return { info, mime, bytes };
}
/** A byte-faithful export is always available; only known text files get terminal previews. */
export function attachmentText(file: LoadedAttachment): string | null {
  if (!/^text\//.test(file.mime) && !/^(txt|md|csv|json|xml|log|ya?ml|ini|ts|js|css|html?|sql)$/i.test(file.info.type)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { return null; }
}
