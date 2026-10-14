import { escapeHtml } from "./format.js";

// A small, explicit Markdown subset rendered to the HTML Teams' composer accepts.
//
// Blocks: paragraphs, `#`/`##`/`###` headings (rendered as h2/h3, Teams' sizes),
// `-`/`*`/`+` and `1.` lists (one level; indented lines continue the item),
// `>` quotes, fenced ``` code blocks. Inline: `code`, **bold**/__bold__,
// *italic*/_italic_, ~~strike~~, [text](url), bare http(s) URLs.
// Raw HTML is escaped and shown literally; anything else is plain text.
//
// Teams renders consecutive <p> with no spacing at all, so blocks are separated
// by an empty paragraph (<p>&nbsp;</p>, which is also what Teams itself writes
// for a blank line).

const SAFE_URL = /^(https?:|mailto:)/i;
const BLANK = "<p>&nbsp;</p>";

function inline(src: string): string {
  // Code spans first, so their content is never touched by other rules.
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  const links: string[] = [];
  const stash = (html: string) => {
    links.push(html);
    return `\u0001${links.length - 1}\u0001`;
  };
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) =>
    SAFE_URL.test(url) ? stash(`<a href="${url}">${text}</a>`) : m,
  );
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => `${pre}${stash(`<a href="${url}">${url}</a>`)}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>").replace(/__(?=\S)([\s\S]*?\S)__/g, "<b>$1</b>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] };

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length <= 2 ? 2 : 3, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const listKind = BULLET.test(line) ? "ul" : ORDERED.test(line) ? "ol" : null;
    if (listKind) {
      const re = listKind === "ul" ? BULLET : ORDERED;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) items.push(m[1]);
        else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      blocks.push({ kind: listKind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s{0,3}(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "p":
          return `<p>${b.lines.map((l) => inline(l.trim())).join("<br>")}</p>`;
        case "h":
          return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
        case "ul":
        case "ol":
          return `<${b.kind}>${b.items.map((it) => `<li>${inline(it)}</li>`).join("")}</${b.kind}>`;
        case "quote":
          return `<blockquote>${b.lines.map((l) => inline(l)).join("<br>")}</blockquote>`;
        case "code":
          return `<pre><code>${b.lines.map(escapeHtml).join("<br>")}</code></pre>`;
      }
    })
    .join(BLANK);
}
