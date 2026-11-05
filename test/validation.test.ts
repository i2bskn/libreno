import { describe, expect, it } from "vitest";
import { normalizeSearchQuery } from "../src/pages/validation";

describe("input validation", () => {
  it("normalizes and validates search queries", () => {
    expect(normalizeSearchQuery("  設計 方針  ")).toBe("設計 方針");
    expect(normalizeSearchQuery("a")).toBe("a");
    expect(normalizeSearchQuery("あ".repeat(100))).toBe("あ".repeat(100));
    expect(normalizeSearchQuery("😀".repeat(100))).toBe("😀".repeat(100));
    expect(normalizeSearchQuery("あ".repeat(101))).toBeNull();
    expect(normalizeSearchQuery("")).toBeNull();
    expect(normalizeSearchQuery("   ")).toBeNull();
    expect(normalizeSearchQuery("a\nb")).toBeNull();
    expect(normalizeSearchQuery("a\tb")).toBeNull();
    expect(normalizeSearchQuery("a\ud800b")).toBeNull();
    expect(normalizeSearchQuery(undefined)).toBeNull();
    expect(normalizeSearchQuery(1)).toBeNull();
  });
});
