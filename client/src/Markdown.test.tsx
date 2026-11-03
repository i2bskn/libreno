import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, isExternalLink } from "./Markdown";

const ORIGIN = "https://wiki.example.test";

function render(body: string): string {
  return renderToStaticMarkup(<Markdown body={body} origin={ORIGIN} />);
}

describe("Markdown", () => {
  it("renders headings, emphasis and lists as elements", () => {
    const html = render("# 見出し\n\n**強調** と *斜体*\n\n- a\n- b\n");
    expect(html).toContain('<div class="markdown">');
    expect(html).toContain("<h1>見出し</h1>");
    expect(html).toContain("<strong>強調</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toMatch(/<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
  });

  it("renders GFM tables in a scrolling wrapper, strikethrough and task lists", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |\n\n~~消す~~\n\n- [x] 済み\n- [ ] まだ\n");
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain("<del>消す</del>");
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/>/);
    expect(html).toMatch(/<input type="checkbox" disabled=""\/>/);
  });

  it("shows raw HTML as text", () => {
    const html = render("前\n\n<script>alert(1)</script>\n\n後 <b>太字</b>\n");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;太字&lt;/b&gt;");
  });

  it("does not render img elements with event handlers from raw HTML", () => {
    const html = render('<img src="x" onerror="alert(1)">\n\n文中 <img src="x" onerror="alert(1)">\n');
    expect(html).not.toMatch(/<img[^>]*onerror/);
  });

  it("empties javascript: URLs", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).toContain("<a");
    expect(html).not.toContain("javascript:");
  });

  it("opens external links in a new tab", () => {
    expect(render("[x](https://example.com)")).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("keeps internal links as they are", () => {
    expect(render("[x](/pages/abc)")).toContain('<a href="/pages/abc">x</a>');
    expect(render(`[x](${ORIGIN}/pages/abc)`)).toContain(`<a href="${ORIGIN}/pages/abc">x</a>`);
  });

  it("renders a link that cannot be parsed as a URL", () => {
    expect(() => render("[x](http://)")).not.toThrow();
    expect(render("[x](http://)")).not.toContain("target=");
  });

  it("does not pass node to the DOM", () => {
    const html = render("[x](https://example.com)\n\n[y](/pages/abc)\n\n| a |\n| - |\n| 1 |\n");
    expect(html).not.toContain("node=");
  });

  it("renders footnotes with a Japanese label", () => {
    const html = render("本文[^1]\n\n[^1]: 注\n");
    expect(html).toMatch(/<h2[^>]*class="sr-only"[^>]*>脚注<\/h2>/);
    expect(html).toContain('aria-label="本文に戻る"');
  });

  it("highlights code blocks that name a language, with classes only", () => {
    const html = render("```js\nconst a = 1;\n```\n");
    expect(html).toContain('<code class="hljs language-js">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    // The CSP (style-src 'self') blocks style attributes.
    expect(html).not.toContain("style=");
  });

  it("does not highlight code blocks without a language", () => {
    expect(render("```\nconst a = 1;\n```\n")).not.toContain("hljs");
  });

  it("shows code blocks in an unknown language as they are", () => {
    expect(() => render("```nosuchlang\nfoo <bar>\n```\n")).not.toThrow();
    const html = render("```nosuchlang\nfoo <bar>\n```\n");
    expect(html).toContain("foo &lt;bar&gt;");
    expect(html).not.toContain('<span class="hljs-');
  });

  it("keeps HTML in code blocks escaped", () => {
    const html = render("```html\n<script>alert(1)</script>\n```\n");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;");
  });

  it("does not highlight inline code", () => {
    const html = render("文中の `const a`");
    expect(html).toContain("<code>const a</code>");
    expect(html).not.toContain("hljs");
  });
});

describe("isExternalLink", () => {
  it.each([
    ["https://example.com", true],
    ["HTTPS://example.com", true],
    ["//example.com", true],
    ["/pages/abc", false],
    [`${ORIGIN}/pages/abc`, false],
    ["mailto:a@example.com", false],
    ["http://", false],
    [undefined, false],
  ])("%s → %s", (href, expected) => {
    expect(isExternalLink(href, ORIGIN)).toBe(expected);
  });
});
