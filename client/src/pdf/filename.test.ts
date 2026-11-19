import { describe, expect, it } from "vitest";
import { pdfFilename } from "../../../src/pdf/filename";

describe("pdfFilename", () => {
  it("adds .pdf to the title", () => {
    expect(pdfFilename("Quote")).toBe("Quote.pdf");
    expect(pdfFilename("見積書 2026年11月")).toBe("見積書 2026年11月.pdf");
  });

  it("replaces the characters that file systems reject, and control characters", () => {
    expect(pdfFilename('a\\b/c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.pdf");
    expect(pdfFilename("a\nb\tc\u007fd")).toBe("a_b_c_d.pdf");
  });

  it("removes spaces and dots at both ends", () => {
    expect(pdfFilename("  ..報告書.. ")).toBe("報告書.pdf");
  });

  it("is document.pdf when nothing is left", () => {
    expect(pdfFilename("")).toBe("document.pdf");
    expect(pdfFilename(" . . ")).toBe("document.pdf");
  });

  it("keeps 100 code points, and removes the spaces and dots the cut leaves at the end", () => {
    expect(pdfFilename("あ".repeat(150))).toBe(`${"あ".repeat(100)}.pdf`);
    expect(pdfFilename("😀".repeat(101))).toBe(`${"😀".repeat(100)}.pdf`);
    expect(pdfFilename(`${"a".repeat(98)}. b`)).toBe(`${"a".repeat(98)}.pdf`);
  });
});
