import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/markdown.js";

describe("markdownToHtml", () => {
  it("renders inline formatting", () => {
    expect(markdownToHtml("**b** *i* _i2_ ~~s~~ `c*d*` [t](https://x.io/a_b)")).toBe(
      '<p><b>b</b> <i>i</i> <i>i2</i> <s>s</s> <code>c*d*</code> <a href="https://x.io/a_b">t</a></p>',
    );
  });

  it("autolinks bare urls without mangling underscores", () => {
    expect(markdownToHtml("see https://x.io/snake_case_path now")).toBe('<p>see <a href="https://x.io/snake_case_path">https://x.io/snake_case_path</a> now</p>');
  });

  it("escapes raw HTML and refuses unsafe link schemes", () => {
    expect(markdownToHtml("<b>x</b> [a](javascript:alert(1))")).toBe("<p>&lt;b&gt;x&lt;/b&gt; [a](javascript:alert(1))</p>");
  });

  it("renders blocks: headings, lists, quotes, code, paragraphs", () => {
    const md = "# Title\n\nline one\nline two\n\n- a\n- b\n  continued\n\n1. x\n2. y\n\n> quoted\n\n```\nif (a < b) {\n  go();\n}\n```";
    const B = "<p>&nbsp;</p>";
    expect(markdownToHtml(md)).toBe(
      ["<h2>Title</h2>", "<p>line one<br>line two</p>", "<ul><li>a</li><li>b continued</li></ul>", "<ol><li>x</li><li>y</li></ol>",
        "<blockquote>quoted</blockquote>", "<pre><code>if (a &lt; b) {<br>  go();<br>}</code></pre>"].join(B),
    );
  });

  it("separates paragraphs with a blank paragraph (Teams gives <p> no margin)", () => {
    expect(markdownToHtml("one\n\ntwo")).toBe("<p>one</p><p>&nbsp;</p><p>two</p>");
  });

  it("keeps intraword underscores and lone asterisks literal", () => {
    expect(markdownToHtml("snake_case_name and 2 * 3 * 4")).toBe("<p>snake_case_name and 2 * 3 * 4</p>");
  });
});
