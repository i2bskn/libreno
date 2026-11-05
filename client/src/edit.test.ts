import { describe, expect, it } from "vitest";
import type { Folder } from "../../src/api/types";
import {
  type PageFields,
  folderOptions,
  hasNewPageInput,
  hasPageChanges,
  insertMarkdown,
  markdownLinkToPage,
  pageChanges,
  pageUrl,
} from "./edit";
import { descendantIds } from "./folders";

const ORIGINAL: PageFields = { title: "手順", body: "# 手順", folderId: "f1" };

describe("pageChanges", () => {
  it("is empty when nothing changed", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL })).toEqual({});
    expect(hasPageChanges(pageChanges(ORIGINAL, { ...ORIGINAL }))).toBe(false);
  });

  it("does not count spaces around the title as a change", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL, title: "  手順 \n" })).toEqual({});
  });

  it("returns the trimmed title when it changed", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL, title: " 新しい手順 " })).toEqual({ title: "新しい手順" });
  });

  it("returns only the body when only the body changed", () => {
    const changes = pageChanges(ORIGINAL, { ...ORIGINAL, body: "# 手順\n\n追記" });
    expect(changes).toEqual({ body: "# 手順\n\n追記" });
    expect(hasPageChanges(changes)).toBe(true);
  });

  it("counts spaces in the body as a change", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL, body: "# 手順 " })).toEqual({ body: "# 手順 " });
  });

  it("returns only the folder when only the folder changed", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL, folderId: "f2" })).toEqual({ folder_id: "f2" });
  });

  it("returns null for a move to the top level and an ID for a move out of it", () => {
    expect(pageChanges(ORIGINAL, { ...ORIGINAL, folderId: null })).toEqual({ folder_id: null });
    const top: PageFields = { ...ORIGINAL, folderId: null };
    expect(pageChanges(top, { ...top, folderId: "f1" })).toEqual({ folder_id: "f1" });
    expect(pageChanges(top, { ...top })).toEqual({});
  });

  it("returns every field that changed", () => {
    expect(pageChanges(ORIGINAL, { title: "B", body: "b", folderId: null })).toEqual({
      title: "B",
      body: "b",
      folder_id: null,
    });
  });
});

describe("hasNewPageInput", () => {
  const empty: PageFields = { title: "", body: "", folderId: "f1" };

  it("is false for the empty form and a title of only spaces", () => {
    expect(hasNewPageInput(empty, "f1")).toBe(false);
    expect(hasNewPageInput({ ...empty, title: "  " }, "f1")).toBe(false);
  });

  it("is true with a title, a body or another folder", () => {
    expect(hasNewPageInput({ ...empty, title: "a" }, "f1")).toBe(true);
    expect(hasNewPageInput({ ...empty, body: " " }, "f1")).toBe(true);
    expect(hasNewPageInput({ ...empty, folderId: null }, "f1")).toBe(true);
  });
});

function folder(id: string, parentId: string | null, name: string): Folder {
  return {
    id,
    space_id: "s1",
    parent_id: parentId,
    name,
    created_by: null,
    updated_by: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("folderOptions", () => {
  const minutes = folder("m", null, "議事録");
  const y2026 = folder("y26", "m", "2026");
  const y2025 = folder("y25", "m", "2025");
  const april = folder("apr", "y26", "4月");
  const docs = folder("d", null, "資料");
  const folders = [y2026, docs, april, minutes, y2025];

  it("labels the folders with their path and sorts them by the label", () => {
    expect(folderOptions(folders)).toEqual([
      { id: "m", label: "議事録" },
      { id: "y25", label: "議事録 / 2025" },
      { id: "y26", label: "議事録 / 2026" },
      { id: "apr", label: "議事録 / 2026 / 4月" },
      { id: "d", label: "資料" },
    ]);
  });

  it("leaves out the excluded folders", () => {
    const exclude = descendantIds(folders, "y26").add("y26");
    expect(folderOptions(folders, exclude)).toEqual([
      { id: "m", label: "議事録" },
      { id: "y25", label: "議事録 / 2025" },
      { id: "d", label: "資料" },
    ]);
  });

  it("returns nothing without folders", () => {
    expect(folderOptions([])).toEqual([]);
  });
});

describe("insertMarkdown", () => {
  const md = "![a.png](/api/v1/attachments/a1)";

  it.each([
    ["at the end of an empty body", "", null, `${md}`],
    ["in an empty body with a selection", "", { start: 0, end: 0 }, `${md}`],
    ["at the end without a selection", "text", null, `text\n\n${md}`],
    ["at the end after a line break", "text\n", null, `text\n\n${md}`],
    ["at the end after a blank line", "text\n\n", null, `text\n\n${md}`],
    ["at the end after more than one blank line", "text\n\n\n", null, `text\n\n\n${md}`],
    ["right after a list", "- 作成元: x", null, `- 作成元: x\n\n${md}`],
    ["after a list ending with a line break", "- a\n- b\n", null, `- a\n- b\n\n${md}`],
    ["at the start of a line", "one\ntwo", { start: 4, end: 4 }, `one\n\n${md}\n\ntwo`],
    ["in the middle of a paragraph", "onetwo", { start: 3, end: 3 }, `one\n\n${md}\n\ntwo`],
    ["at the end of a line", "one\ntwo", { start: 3, end: 3 }, `one\n\n${md}\n\ntwo`],
    ["between paragraphs", "one\n\ntwo", { start: 5, end: 5 }, `one\n\n${md}\n\ntwo`],
    ["at the start of the body", "one", { start: 0, end: 0 }, `${md}\n\none`],
    ["at the start before blank lines", "\n\n\none", { start: 0, end: 0 }, `${md}\n\n\none`],
    ["in place of the selection", "one TWO three", { start: 4, end: 7 }, `one \n\n${md}\n\n three`],
    ["in place of whole lines", "one\ntwo\nthree", { start: 4, end: 7 }, `one\n\n${md}\n\nthree`],
    ["at the end for a selection past it", "one", { start: 10, end: 12 }, `one\n\n${md}`],
    ["after a line of spaces, not counting them", "a\n \n", null, `a\n \n\n${md}`],
    ["after only a line break", "\n", null, `\n\n${md}`],
    ["after only spaces", "  ", null, `  \n\n${md}`],
  ])("inserts %s", (_, body, selection, expected) => {
    expect(insertMarkdown(body, selection, md).body).toBe(expected);
  });

  it("returns the position right after the inserted text, before the line breaks added after it", () => {
    const first = insertMarkdown("onetwo", { start: 3, end: 3 }, "A");
    expect(first).toEqual({ body: "one\n\nA\n\ntwo", cursor: 6 });
    const second = insertMarkdown(first.body, { start: first.cursor, end: first.cursor }, "B");
    expect(second.body).toBe("one\n\nA\n\nB\n\ntwo");
  });
});

describe("markdownLinkToPage", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("links to the page with its title", () => {
    expect(markdownLinkToPage("手順書", id)).toBe(`[手順書](/pages/${id})`);
  });

  it.each([
    ["[a] b", "\\[a\\] b"],
    ["a\\b", "a\\\\b"],
    ["<https://x.example>", "\\<https://x.example\\>"],
    ["`code`", "\\`code\\`"],
    ["*a* _b_", "\\*a\\* \\_b\\_"],
  ])("escapes %s", (title, escaped) => {
    expect(markdownLinkToPage(title, id)).toBe(`[${escaped}](/pages/${id})`);
  });
});

describe("pageUrl", () => {
  it("joins the origin and the path of the page", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(pageUrl("https://wiki.example", id)).toBe(`https://wiki.example/pages/${id}`);
  });
});
