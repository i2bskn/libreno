import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintDocument, type PrintFields } from "./PrintDocument";

const ORIGIN = "https://wiki.example.test";

const FORMAL: PrintFields = {
  variant: "formal",
  title: "見積書",
  recipient: "株式会社〇〇 御中",
  date: "2026年11月20日",
  version: "1.0",
  issuer: "株式会社サンプル",
  confidentiality: "社外秘",
};

function render(fields: PrintFields, body = "本文"): string {
  return renderToStaticMarkup(<PrintDocument fields={fields} body={body} origin={ORIGIN} />);
}

describe("PrintDocument", () => {
  it("starts the formal document with a cover that has every field", () => {
    const html = render(FORMAL);
    expect(html).toContain('<div class="print-doc" data-variant="formal"><section class="print-cover">');
    expect(html).toContain('<p class="print-cover-confidential">社外秘</p>');
    expect(html).toContain('<p class="print-cover-recipient">株式会社〇〇 御中</p>');
    expect(html).toContain('<h1 class="print-cover-title">見積書</h1>');
    expect(html).toContain(
      '<dl class="print-cover-meta"><div><dt>日付</dt><dd>2026年11月20日</dd></div>' +
        "<div><dt>版数</dt><dd>1.0</dd></div><div><dt>発行者</dt><dd>株式会社サンプル</dd></div></dl>",
    );
    expect(html).toContain('<main class="print-body"><div class="markdown"><p>本文</p></div></main>');
    expect(html).not.toContain("print-title");
  });

  it("leaves out the empty fields of the cover", () => {
    const html = render({ ...FORMAL, recipient: "", version: " ", issuer: "", confidentiality: "", date: "" });
    expect(html).not.toContain("print-cover-confidential");
    expect(html).not.toContain("print-cover-recipient");
    expect(html).not.toContain("print-cover-meta");
    expect(html).toContain('<h1 class="print-cover-title">見積書</h1>');

    const dateOnly = render({ ...FORMAL, version: "", issuer: "" });
    expect(dateOnly).toContain('<dl class="print-cover-meta"><div><dt>日付</dt><dd>2026年11月20日</dd></div></dl>');
  });

  it("starts the simple document with the title and no cover", () => {
    const html = render({ ...FORMAL, variant: "simple" });
    expect(html).toContain('<div class="print-doc" data-variant="simple"><h1 class="print-title">見積書</h1>');
    expect(html).not.toContain("print-cover");
    expect(html).not.toContain("株式会社〇〇");
    expect(html).not.toContain("社外秘");
  });

  it("shows the values as text", () => {
    const html = render({
      ...FORMAL,
      title: "<script>alert(1)</script>",
      recipient: '<img src=x onerror="1">',
      confidentiality: "<b>秘</b>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;秘&lt;/b&gt;");
  });
});
