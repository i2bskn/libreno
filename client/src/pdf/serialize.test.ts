import { describe, expect, it } from "vitest";
import { absolutizeHref, buildPdfHtml } from "./serialize";

const ORIGIN = "https://wiki.example.test";

describe("absolutizeHref", () => {
  it("keeps links inside the document", () => {
    expect(absolutizeHref("#fn-1", ORIGIN)).toBe("#fn-1");
    expect(absolutizeHref("#user-content-fnref-1", ORIGIN)).toBe("#user-content-fnref-1");
  });

  it("makes links to this site absolute", () => {
    expect(absolutizeHref("/pages/abc", ORIGIN)).toBe("https://wiki.example.test/pages/abc");
    expect(absolutizeHref("pages/abc?x=1#y", ORIGIN)).toBe("https://wiki.example.test/pages/abc?x=1#y");
  });

  it("keeps absolute links to other sites", () => {
    expect(absolutizeHref("https://example.com/a b", ORIGIN)).toBe("https://example.com/a%20b");
    expect(absolutizeHref("mailto:a@example.com", ORIGIN)).toBe("mailto:a@example.com");
  });

  it("returns null for a link that cannot be parsed", () => {
    expect(absolutizeHref("http://[::1", ORIGIN)).toBeNull();
  });
});

describe("buildPdfHtml", () => {
  it("makes a complete document with the CSS and the body", () => {
    const html = buildPdfHtml({ title: "見積書", css: "body{}", dynamicCss: "@page{}", bodyHtml: "<p>本文</p>" });
    expect(html).toBe(
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>見積書</title>' +
        "<style>body{}</style><style>@page{}</style></head><body><p>本文</p></body></html>",
    );
  });

  it("escapes the title", () => {
    const html = buildPdfHtml({ title: `</title><script>"&'`, css: "", dynamicCss: "", bodyHtml: "" });
    expect(html).toContain("<title>&#60;/title&#62;&#60;script&#62;&#34;&#38;&#39;</title>");
  });

  it("does not let either CSS end its <style> element", () => {
    const html = buildPdfHtml({
      title: "t",
      css: "a{}</style><script>1</script>",
      dynamicCss: "b{}</STYLE ><p>",
      bodyHtml: "",
    });
    expect(html).toContain("<style>a{}<\\/style><script>1</script></style>");
    expect(html).toContain("<style>b{}<\\/style ><p></style>");
    expect(html.match(/<\/style/gi)).toHaveLength(2);
  });
});
