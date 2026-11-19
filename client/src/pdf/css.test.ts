import { describe, expect, it } from "vitest";
import { buildDynamicCss, cssString } from "./css";

describe("cssString", () => {
  it("quotes plain text as it is", () => {
    expect(cssString("社外秘")).toBe('"社外秘"');
    expect(cssString("")).toBe('""');
  });

  it("escapes quotes, backslashes and angle brackets as hex escapes ended by a space", () => {
    expect(cssString('a"b')).toBe('"a\\22 b"');
    expect(cssString("a\\b")).toBe('"a\\5c b"');
    expect(cssString("</style>")).toBe('"\\3c /style\\3e "');
  });

  it("escapes line breaks and control characters", () => {
    expect(cssString("a\nb")).toBe('"a\\a b"');
    expect(cssString("a\r\tb")).toBe('"a\\d \\9 b"');
    expect(cssString("a\u0000b\u007fc\u0085")).toBe('"a\\0 b\\7f c\\85 "');
  });

  it("keeps a hex digit after an escape apart from it", () => {
    // Without the space, \22 followed by "1" would read as \221.
    expect(cssString('"1')).toBe('"\\22 1"');
  });
});

describe("buildDynamicCss", () => {
  it("is empty without a label or a cover", () => {
    expect(buildDynamicCss({ confidentiality: "", hasCover: false })).toBe("");
    expect(buildDynamicCss({ confidentiality: "   ", hasCover: false })).toBe("");
  });

  it("puts the trimmed label in the top right of every page", () => {
    expect(buildDynamicCss({ confidentiality: " 社外秘 ", hasCover: false })).toBe(
      '@page { @top-right { content: "社外秘"; } }',
    );
  });

  it("hides the page number and the label on the cover", () => {
    const css = buildDynamicCss({ confidentiality: "社外秘", hasCover: true });
    expect(css).toContain('@page { @top-right { content: "社外秘"; } }');
    expect(css).toContain("@page :first { @top-right { content: none; } @bottom-center { content: none; } }");
    expect(buildDynamicCss({ confidentiality: "", hasCover: true })).toBe(
      "@page :first { @top-right { content: none; } @bottom-center { content: none; } }",
    );
  });

  it("cannot end a <style> element or the string with the label", () => {
    const css = buildDynamicCss({ confidentiality: '</style><script>"x"', hasCover: false });
    expect(css).not.toContain("<");
    expect(css).not.toContain(">");
    expect(css).toBe('@page { @top-right { content: "\\3c /style\\3e \\3c script\\3e \\22 x\\22 "; } }');
  });
});
