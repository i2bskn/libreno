import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatFileSize,
  formatPurgeRemaining,
  formatSnippet,
  spaceDisplayName,
  splitByQuery,
  widerVisibilityWarning,
} from "./format";

describe("spaceDisplayName", () => {
  it("shows personal spaces as 個人スペース", () => {
    expect(spaceDisplayName({ kind: "personal", name: null })).toBe("個人スペース");
  });

  it("shows other spaces by name", () => {
    expect(spaceDisplayName({ kind: "everyone", name: "開発" })).toBe("開発");
    expect(spaceDisplayName({ kind: "admin", name: "管理" })).toBe("管理");
  });
});

describe("formatDateTime", () => {
  it("formats in the given time zone", () => {
    expect(formatDateTime(Date.UTC(2026, 9, 30, 3, 4), "Asia/Tokyo")).toBe("2026/10/30 12:04");
  });
});

describe("formatSnippet", () => {
  it("joins lines and collapses whitespace", () => {
    expect(formatSnippet("手順\n\n1. 設計\t方針  を  決める\r\n")).toBe("…手順 1. 設計 方針 を 決める…");
  });

  it("drops the marks of headings, lists, quotes, emphasis and code", () => {
    expect(formatSnippet("# 手順\n- **領収書**を撮る\n> 注意\n* `expense list`")).toBe(
      "…手順 領収書を撮る 注意 expense list…",
    );
  });

  it("keeps the text of links and drops their URLs", () => {
    expect(formatSnippet("[経費申請](/pages/abc) と ![図](/api/v1/attachments/x)")).toBe("…経費申請 と 図…");
  });

  it("drops the URL of a link cut at either end", () => {
    expect(formatSnippet("-4726-81f0) — 入社した人向け\n- [経費申請の手順](/pages/cb871ec5-be7e")).toBe(
      "…— 入社した人向け 経費申請の手順…",
    );
  });

  it("keeps numbers, dashes and parentheses in ordinary text", () => {
    expect(formatSnippet("1. 設計 (案) を 2026-10 に決める")).toBe("…1. 設計 (案) を 2026-10 に決める…");
  });

  it("adds … on both sides", () => {
    expect(formatSnippet("  abc  ")).toBe("…abc…");
    expect(formatSnippet("abc")).toBe("…abc…");
  });
});

describe("splitByQuery", () => {
  it("marks every match, ignoring case", () => {
    expect(splitByQuery("API と api の申請", "Api")).toEqual([
      { text: "API", match: true },
      { text: " と ", match: false },
      { text: "api", match: true },
      { text: " の申請", match: false },
    ]);
  });

  it("returns the whole text when nothing matches or the query is empty", () => {
    expect(splitByQuery("申請", "経費")).toEqual([{ text: "申請", match: false }]);
    expect(splitByQuery("申請", " ")).toEqual([{ text: "申請", match: false }]);
  });
});

describe("formatPurgeRemaining", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 30);

  it("counts whole days, rounded up", () => {
    expect(formatPurgeRemaining(NOW + 30 * DAY, NOW)).toBe("あと 30 日で完全に削除されます");
    expect(formatPurgeRemaining(NOW + DAY, NOW)).toBe("あと 1 日で完全に削除されます");
    expect(formatPurgeRemaining(NOW + DAY / 2, NOW)).toBe("あと 1 日で完全に削除されます");
  });

  it("says soon at or after the time", () => {
    expect(formatPurgeRemaining(NOW, NOW)).toBe("まもなく完全に削除されます");
    expect(formatPurgeRemaining(NOW - DAY, NOW)).toBe("まもなく完全に削除されます");
  });
});

describe("widerVisibilityWarning", () => {
  it("warns about a space more people can see, with the kinds and the revisions", () => {
    expect(widerVisibilityWarning({ id: "a", kind: "personal" }, { id: "b", kind: "everyone", name: "開発" })).toBe(
      "移動先の「開発」は、今のスペースより多くの人が見られます（自分だけ → 全員）。" +
        "ページの過去の版（履歴）と添付ファイルも見られるようになります。",
    );
    expect(widerVisibilityWarning({ id: "a", kind: "admin" }, { id: "b", kind: "everyone", name: "開発" })).toContain(
      "（管理者のみ → 全員）",
    );
    expect(widerVisibilityWarning({ id: "a", kind: "personal" }, { id: "b", kind: "admin", name: "管理" })).toContain(
      "「管理」",
    );
  });

  it("warns about a members space from an admin space, and about an everyone space from a members space", () => {
    expect(widerVisibilityWarning({ id: "a", kind: "admin" }, { id: "b", kind: "members", name: "チーム" })).toBe(
      "移動先の「チーム」は、今のスペースより多くの人が見られます（管理者のみ → メンバー指定）。" +
        "ページの過去の版（履歴）と添付ファイルも見られるようになります。",
    );
    expect(widerVisibilityWarning({ id: "a", kind: "members" }, { id: "b", kind: "everyone", name: "開発" })).toContain(
      "（メンバー指定 → 全員）",
    );
  });

  it("warns about another members space, whose members may differ", () => {
    expect(widerVisibilityWarning({ id: "a", kind: "members" }, { id: "b", kind: "members", name: "別チーム" })).toBe(
      "移動先の「別チーム」は、今のスペースとは見られる人が違います（メンバー指定 → メンバー指定）。" +
        "ページの過去の版（履歴）と添付ファイルも見られるようになります。",
    );
  });

  it("is null for a space of the same kind or one fewer people can see", () => {
    expect(widerVisibilityWarning({ id: "a", kind: "everyone" }, { id: "b", kind: "everyone", name: "別" })).toBeNull();
    expect(widerVisibilityWarning({ id: "a", kind: "everyone" }, { id: "b", kind: "admin", name: "管理" })).toBeNull();
    expect(widerVisibilityWarning({ id: "a", kind: "admin" }, { id: "b", kind: "personal", name: null })).toBeNull();
    expect(widerVisibilityWarning({ id: "a", kind: "members" }, { id: "b", kind: "admin", name: "管理" })).toBeNull();
    expect(widerVisibilityWarning({ id: "a", kind: "everyone" }, { id: "b", kind: "members", name: "チーム" })).toBeNull();
  });

  it("is null within the same members space", () => {
    expect(widerVisibilityWarning({ id: "a", kind: "members" }, { id: "a", kind: "members", name: "チーム" })).toBeNull();
  });
});

describe("formatFileSize", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024 - 1, "1024.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [10 * 1024 * 1024, "10.0 MB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
