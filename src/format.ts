const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Out-of-range and surrogate code points would throw; HTML maps them to U+FFFD.
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : "\ufffd";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Teams message HTML to compact plain text that keeps structure an agent needs. */
export function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, "\n");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // A paragraph holding only a non-breaking space is how Teams writes a blank line.
  s = s.replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|\u00a0)*(?:&nbsp;|&#160;|\u00a0)(?:\s|&nbsp;|&#160;|\u00a0)*<\/p>/gi, "<p><br></p>");
  // Inside <pre>, source newlines and indentation are content: protect them from collapsing.
  const NL = "\u0002";
  const SP = "\u0003";
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) =>
    `<pre>${body.replace(/<br\s*\/?>/gi, "\n").replace(/\n/g, NL).replace(/ /g, SP).replace(/\t/g, SP.repeat(4))}</pre>`,
  );
  // Mentions: <span itemtype="http://schema.skype.com/Mention" ...>Name</span>
  s = s.replace(/<span[^>]*itemtype="http:\/\/schema\.skype\.com\/Mention"[^>]*>([\s\S]*?)<\/span>/gi, "@$1");
  // Emoji images carry their glyph in alt.
  s = s.replace(/<img[^>]*\balt="([^"]*)"[^>]*itemtype="http:\/\/schema\.skype\.com\/Emoji"[^>]*>/gi, "$1");
  s = s.replace(/<img[^>]*itemtype="http:\/\/schema\.skype\.com\/Emoji"[^>]*\balt="([^"]*)"[^>]*>/gi, "$1");
  s = s.replace(/<img[^>]*>/gi, "[image]");
  s = s.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href);
    return !text || decodeEntities(text) === url ? url : `${text} (${url})`;
  });
  // Block boundaries become a sentinel so that adjacent blocks yield one line break,
  // while an explicit <br> inside an otherwise empty block still yields a blank line.
  const B = "\u0001";
  // One line per table row, cells joined with " | " (cells often wrap their text in <p>).
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
    // Re-escape converted cell text: the outer pass strips tags and decodes entities once more.
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      escapeHtml(htmlToText(c[1]).replace(/\s*\n\s*/g, " ")),
    );
    return `${B}${cells.join(" | ")}${B}`;
  });
  s = s.replace(/\n/g, " "); // source newlines are formatting, not content
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, `${B}- `);
  s = s.replace(/<blockquote[^>]*>/gi, `${B}> `);
  s = s.replace(/<\/?(p|div|ul|ol|li|table|thead|tbody|tr|h[1-6]|pre|blockquote|figure)\b[^>]*>/gi, B);
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]*\u0001[\s\u0001]*/g, (m) => (m.includes("\n") ? "\n\n" : "\n"));
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0002/g, "\n")
    .replace(/\u0003/g, " ");
}

/** Adaptive cards arrive as `<URIObject ...><Swift b64="..."/>`; pull the readable text out. */
export function cardToText(content: string): string {
  const b64 = /<Swift\b[^>]*\bb64="([^"]+)"/i.exec(content)?.[1];
  if (!b64) return "";
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return "";
  }
  const MAX = 40;
  const parts: string[] = [];
  let omitted = 0;
  const add = (v: string) => {
    const t = v.replace(/\s+/g, " ").trim();
    if (!t || parts.includes(t)) return;
    if (parts.length < MAX) parts.push(t);
    else omitted++;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Type-aware walk over Adaptive Cards (TextBlock, RichTextBlock, FactSet,
  // Action.OpenUrl incl. selectAction) and Bot Framework hero/thumbnail cards.
  const walk = (node: unknown, inImage = false): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, inImage));
    const o = node as Record<string, unknown>;
    const type = str(o.type);
    if (type === "FactSet" && Array.isArray(o.facts)) {
      for (const f of o.facts as Array<Record<string, unknown>>) add(`${str(f.title)}: ${str(f.value)}`);
      return;
    }
    if (type === "Action.OpenUrl" || (type === "openUrl" && o.value)) {
      const url = str(o.url) || str(o.value);
      // Avatar/image click targets are noise; keep titled actions and link targets of text.
      if (url && !inImage) add(o.title ? `${str(o.title)} (${url})` : url);
      return;
    }
    if (type.startsWith("Action.")) {
      if (o.title) add(`[${str(o.title)}]`);
      return;
    }
    for (const key of ["title", "text", "subtitle"]) add(str(o[key]));
    const isImage = inImage || type === "Image";
    for (const [k, v] of Object.entries(o)) {
      if (k === "title" || k === "text" || k === "subtitle" || k === "url" || k === "altText") continue;
      walk(v, isImage);
    }
  };
  walk(payload);
  const out = parts.join(" · ");
  return omitted ? `${out} · (+${omitted} more card fields)` : out;
}

export interface MessageLike {
  type: string | null;
  content: string;
  files?: string[];
  deleted?: boolean;
  subject?: string | null;
}

/** Plain-text body for any message type; empty string for non-message events. */
export function messageText(m: MessageLike): string {
  if (m.deleted) return "(deleted)";
  const type = m.type ?? "";
  let text: string;
  // Cards are posted by apps/bots (e.g. GitHub notifications), not typed by a person.
  if (type === "RichText/Media_Card") text = `[app card] ${cardToText(m.content)}`.trim();
  else if (type.startsWith("RichText/Media_")) text = `[${type.slice("RichText/Media_".length).toLowerCase()}]`;
  else if (type === "Text") text = decodeEntities(m.content).trim();
  else if (type.startsWith("RichText")) text = htmlToText(m.content);
  else return "";
  if (m.subject) text = `${m.subject}\n${text}`;
  if (m.files?.length) text = `${text}${text ? "\n" : ""}[files: ${m.files.join(", ")}]`;
  return text;
}

/** Truncate with a size hint so callers can request the full content. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}… (+${text.length - max} chars)`, truncated: true };
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ⏎ ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:MM" (unambiguous, sortable, short). */
export function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text to Teams HTML: one paragraph per line, blank lines preserved. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
    .join("");
}
