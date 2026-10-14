import { describe, expect, it } from "vitest";
import { cardToText, decodeEntities, htmlToText, messageText, textToHtml, truncate } from "../src/format.js";

describe("htmlToText", () => {
  it("keeps paragraphs, lists and quotes as lines", () => {
    const html = "<h2>Title</h2>\r\n<p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote>";
    expect(htmlToText(html)).toBe("Title\nHello world\n- one\n- two\n> quoted");
  });

  it("renders links as text (url) unless the text is the url", () => {
    expect(htmlToText('<a href="https://a.example/x?y=1&amp;z=2">docs</a>')).toBe("docs (https://a.example/x?y=1&z=2)");
    expect(htmlToText('<a href="https://a.example/">https://a.example/</a>')).toBe("https://a.example/");
  });

  it("turns mentions into @name and images into a marker", () => {
    const html = '<p><span itemtype="http://schema.skype.com/Mention" itemid="0">Ana</span> veja <img src="x.png"></p>';
    expect(htmlToText(html)).toBe("@Ana veja [image]");
  });

  it("uses the glyph for emoji images", () => {
    expect(htmlToText('<img alt="😀" itemtype="http://schema.skype.com/Emoji" src="e.png">')).toBe("😀");
  });

  it("renders one line per table row even when cells wrap text in <p>", () => {
    const html = "<table><tr><th><p>a</p></th><th><p>b</p></th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(htmlToText(html)).toBe("a | b\n1 | 2");
  });

  it("treats a paragraph holding only a non-breaking space as a blank line", () => {
    expect(htmlToText("<p>a</p>\r\n<p>&nbsp;</p><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>a</p><p>\u00a0</p><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>a</p><p></p><p>b</p>")).toBe("a\nb");
  });

  it("keeps newlines and indentation inside <pre>", () => {
    expect(htmlToText("<p>code:</p><pre><code>if (x) {<br>    y();\n}</code></pre>")).toBe("code:\nif (x) {\n    y();\n}");
  });

  it("keeps escaped markup inside table cells literal", () => {
    expect(htmlToText("<table><tr><td>&lt;b&gt;x&lt;/b&gt;</td><td>a &amp; b</td></tr></table>")).toBe("<b>x</b> | a & b");
  });

  it("decodes entities and collapses blank runs", () => {
    expect(htmlToText("<p>x &lt;y&gt; &#233; &#x1F600;</p><p><br></p><p>z</p>")).toBe("x <y> é 😀\n\nz");
  });
});

describe("cardToText", () => {
  it("extracts titles and text from the Swift payload", () => {
    const payload = { attachments: [{ content: { body: [{ type: "TextBlock", text: "PR #12 merged" }, { type: "TextBlock", text: "by ana" }] } }] };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(cardToText(`<URIObject type="SWIFT.1"><Title>Card</Title><Swift b64="${b64}"/></URIObject>`)).toBe("PR #12 merged · by ana");
  });

  it("extracts facts and titled URL actions, skipping image click targets", () => {
    const payload = {
      attachments: [{ content: {
        body: [
          { type: "Image", url: "https://img", selectAction: { type: "Action.OpenUrl", url: "https://avatar" } },
          { type: "TextBlock", text: "Build failed" },
          { type: "FactSet", facts: [{ title: "Branch", value: "main" }] },
          { type: "TextBlock", text: "details", selectAction: { type: "Action.OpenUrl", url: "https://ci/1" } },
        ],
        actions: [{ type: "Action.OpenUrl", title: "Open run", url: "https://ci/run" }, { type: "Action.Submit", title: "Retry" }],
      } }],
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(cardToText(`<Swift b64="${b64}"/>`)).toBe("Build failed · Branch: main · details · https://ci/1 · Open run (https://ci/run) · [Retry]");
  });

  it("reads hero cards with openUrl buttons", () => {
    const payload = { attachments: [{ content: { title: "Deploy", text: "done", buttons: [{ type: "openUrl", title: "View", value: "https://x" }] } }] };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(cardToText(`<Swift b64="${b64}"/>`)).toBe("Deploy · done · View (https://x)");
  });

  it("says how many card fields were left out", () => {
    const body = Array.from({ length: 45 }, (_, i) => ({ type: "TextBlock", text: `line ${i}` }));
    const b64 = Buffer.from(JSON.stringify({ body })).toString("base64");
    expect(cardToText(`<Swift b64="${b64}"/>`)).toMatch(/line 39 · \(\+5 more card fields\)$/);
  });

  it("returns empty for a card without payload", () => {
    expect(cardToText("<URIObject></URIObject>")).toBe("");
  });
});

describe("messageText", () => {
  it("marks deleted messages and lists files", () => {
    expect(messageText({ type: "RichText/Html", content: "", deleted: true })).toBe("(deleted)");
    expect(messageText({ type: "RichText/Html", content: "<p>see</p>", files: ["a.png"] })).toBe("see\n[files: a.png]");
  });

  it("returns empty for system events so callers can skip them", () => {
    expect(messageText({ type: "ThreadActivity/AddMember", content: "<addmember/>" })).toBe("");
  });

  it("labels other media types", () => {
    expect(messageText({ type: "RichText/Media_CallRecording", content: "<x/>" })).toBe("[callrecording]");
  });
});

describe("helpers", () => {
  it("truncate reports how much was cut", () => {
    expect(truncate("abcdef", 10)).toEqual({ text: "abcdef", truncated: false });
    expect(truncate("abcdefghij", 4)).toEqual({ text: "abcd… (+6 chars)", truncated: true });
  });

  it("textToHtml escapes and keeps blank lines", () => {
    expect(textToHtml("a < b\n\nc")).toBe("<p>a &lt; b</p><p><br></p><p>c</p>");
  });

  it("decodeEntities maps invalid code points to U+FFFD instead of throwing", () => {
    expect(decodeEntities("a&#1114112;b&#xD800;c")).toBe("a\ufffdb\ufffdc");
  });

  it("decodeEntities leaves unknown entities alone", () => {
    expect(decodeEntities("&bogus; &amp;")).toBe("&bogus; &");
  });
});
