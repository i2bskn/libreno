import { describe, expect, it, vi } from "vitest";
import type {
  Folder,
  Page,
  PageRevision,
  PageRevisionSummary,
  PageSummary,
  SearchHit,
  Space,
  TrashedPage,
  User,
} from "../../src/api/types";
import { createApiClient, createApiFetch } from "./api";
import {
  loadArchiveView,
  loadBacklinks,
  loadFolderView,
  loadHomeView,
  loadPageEditView,
  loadPageHistoryView,
  loadPageList,
  loadPageNewView,
  loadPageRevisionView,
  loadPageView,
  loadSearchView,
  loadSpaceView,
  loadTopPage,
  loadTrashView,
  loadUsersView,
} from "./load";

const SPACE: Space = { id: "s1", kind: "everyone", name: "開発", sort_order: 0, archived_at: null, created_at: 1, updated_at: 2 };
const SUMMARY: PageSummary = {
  id: "p1",
  space_id: "s1",
  folder_id: null,
  title: "手順",
  version: 1,
  created_by: "u1",
  updated_by: "u1",
  created_at: 1,
  updated_at: 2,
};
const PAGE: Page = { ...SUMMARY, body: "# 手順" };
const FOLDER: Folder = {
  id: "f1",
  space_id: "s1",
  parent_id: null,
  name: "資料",
  created_by: "u1",
  updated_by: "u1",
  created_at: 1,
  updated_at: 2,
};

type Reply = () => Response;

function json(code: number, body: unknown): Reply {
  return () => Response.json(body, { status: code });
}

function apiError(code: number, message: string): Reply {
  return json(code, { error: { code: "error", message } });
}

const REVISION_SUMMARY: PageRevisionSummary = { version: 1, title: "旧手順", created_by: "u1", created_at: 1 };
const REVISION: PageRevision = { page_id: "p1", ...REVISION_SUMMARY, body: "# 旧手順" };

// fetch that answers each URL from its own queue, in order. /auth/refresh answers 204 unless given.
function setup(routes: Record<string, Reply[]>) {
  const queues = new Map(Object.entries(routes).map(([url, replies]) => [url, [...replies]]));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    const reply = queues.get(url)?.shift() ?? (url === "/auth/refresh" ? () => new Response(null, { status: 204 }) : null);
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  const calls = (url: string) => fetch.mock.calls.filter(([input]) => String(input) === url).length;
  return { client, fetch, redirectToLogin, calls };
}

const unauthorized = apiError(401, "ログインしてください");

describe("loadHomeView", () => {
  it("shows the spaces and the top page", async () => {
    const { client } = setup({
      "/api/v1/spaces": [json(200, { spaces: [SPACE] })],
      "/api/v1/top-page": [json(200, { page: PAGE })],
    });
    expect(await loadHomeView(client)).toEqual({
      kind: "ready",
      data: { spaces: [SPACE], topPage: PAGE, topPageError: false },
    });
  });

  it("shows the spaces without a top page when none is set", async () => {
    const { client } = setup({
      "/api/v1/spaces": [json(200, { spaces: [SPACE] })],
      "/api/v1/top-page": [json(200, { page: null })],
    });
    expect(await loadHomeView(client)).toEqual({
      kind: "ready",
      data: { spaces: [SPACE], topPage: null, topPageError: false },
    });
  });

  it.each([
    ["500", apiError(500, "サーバーでエラーが発生しました")],
    ["404", apiError(404, "見つかりません")],
  ])("shows the spaces when only the top page fails with %s", async (_, reply) => {
    const { client } = setup({
      "/api/v1/spaces": [json(200, { spaces: [SPACE] })],
      "/api/v1/top-page": [reply],
    });
    expect(await loadHomeView(client)).toEqual({
      kind: "ready",
      data: { spaces: [SPACE], topPage: null, topPageError: true },
    });
  });

  it("is an error with the API message when the spaces fail", async () => {
    const { client } = setup({
      "/api/v1/spaces": [apiError(500, "サーバーでエラーが発生しました")],
      "/api/v1/top-page": [json(200, { page: PAGE })],
    });
    expect(await loadHomeView(client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it.each(["/api/v1/spaces", "/api/v1/top-page"])(
    "moves to the login page when %s stays 401 after the refresh",
    async (url) => {
      const routes: Record<string, Reply[]> = {
        "/api/v1/spaces": [json(200, { spaces: [] })],
        "/api/v1/top-page": [json(200, { page: null })],
        "/auth/refresh": [() => new Response(null, { status: 401 })],
      };
      routes[url] = [unauthorized, unauthorized];
      const { client, redirectToLogin } = setup(routes);
      expect(await loadHomeView(client)).toEqual({ kind: "redirecting" });
      expect(redirectToLogin).toHaveBeenCalledTimes(1);
    },
  );
});

describe("loadTopPage", () => {
  it("is ok with the page or null", async () => {
    const { client } = setup({ "/api/v1/top-page": [json(200, { page: PAGE }), json(200, { page: null })] });
    expect(await loadTopPage(client)).toEqual({ kind: "ok", value: PAGE });
    expect(await loadTopPage(client)).toEqual({ kind: "ok", value: null });
  });

  it("is an error when the request fails", async () => {
    const { client } = setup({ "/api/v1/top-page": [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadTopPage(client)).toEqual({ kind: "error" });
  });
});

describe("loadBacklinks", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const url = `/api/v1/pages/${id}/backlinks`;

  it("is ok with the pages and has_more", async () => {
    const { client } = setup({ [url]: [json(200, { pages: [SUMMARY], has_more: true })] });
    expect(await loadBacklinks(client, id)).toEqual({ kind: "ok", value: { pages: [SUMMARY], hasMore: true } });
  });

  it("is an error when the page is 404", async () => {
    const { client } = setup({ [url]: [apiError(404, "ページが見つかりません")] });
    expect(await loadBacklinks(client, id)).toEqual({ kind: "error" });
  });

  it("is an error when the request fails", async () => {
    const { client } = setup({ [url]: [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadBacklinks(client, id)).toEqual({ kind: "error" });
  });

  it("is an error without a request for an invalid id", async () => {
    const { client, fetch } = setup({});
    expect(await loadBacklinks(client, "../x")).toEqual({ kind: "error" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadPageList", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const url = `/api/v1/spaces/${id}/pages`;

  it("is ok with the pages", async () => {
    const { client } = setup({ [url]: [json(200, { pages: [SUMMARY] })] });
    expect(await loadPageList(client, id)).toEqual({ kind: "ok", value: [SUMMARY] });
  });

  it("is an error when the space is 404", async () => {
    const { client } = setup({ [url]: [apiError(404, "スペースが見つかりません")] });
    expect(await loadPageList(client, id)).toEqual({ kind: "error" });
  });

  it("is an error when the request fails", async () => {
    const { client } = setup({ [url]: [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadPageList(client, id)).toEqual({ kind: "error" });
  });

  it("moves to the login page when it stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      [url]: [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadPageList(client, id)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("is an error without a request for an invalid id", async () => {
    const { client, fetch } = setup({});
    expect(await loadPageList(client, "../x")).toEqual({ kind: "error" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadSpaceView", () => {
  it("shows the space, its folders and its pages", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
      "/api/v1/spaces/s1/pages": [json(200, { pages: [SUMMARY] })],
    });
    expect(await loadSpaceView(client, "s1")).toEqual({
      kind: "ready",
      data: { space: SPACE, folders: [FOLDER], pages: [SUMMARY] },
    });
  });

  it("is not found when the space is 404", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/folders": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/pages": [apiError(404, "スペースが見つかりません")],
    });
    expect(await loadSpaceView(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message when the page list is 500", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [] })],
      "/api/v1/spaces/s1/pages": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadSpaceView(client, "s1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is an error with the API message when only the folder list fails", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [apiError(500, "サーバーでエラーが発生しました")],
      "/api/v1/spaces/s1/pages": [json(200, { pages: [SUMMARY] })],
    });
    expect(await loadSpaceView(client, "s1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it.each(["/api/v1/spaces/s1", "/api/v1/spaces/s1/folders", "/api/v1/spaces/s1/pages"])(
    "moves to the login page when %s stays 401 after the refresh",
    async (url) => {
      const routes: Record<string, Reply[]> = {
        "/api/v1/spaces/s1": [json(200, SPACE)],
        "/api/v1/spaces/s1/folders": [json(200, { folders: [] })],
        "/api/v1/spaces/s1/pages": [json(200, { pages: [] })],
        "/auth/refresh": [() => new Response(null, { status: 401 })],
      };
      routes[url] = [unauthorized, unauthorized];
      const { client, redirectToLogin } = setup(routes);
      expect(await loadSpaceView(client, "s1")).toEqual({ kind: "redirecting" });
      expect(redirectToLogin).toHaveBeenCalledTimes(1);
    },
  );

  it("prefers not found to an error", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/folders": [apiError(500, "サーバーでエラーが発生しました")],
      "/api/v1/spaces/s1/pages": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadSpaceView(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadSpaceView(client, "../users")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadPageView", () => {
  it("shows the page, its space and the folders of the space", async () => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
    });
    expect(await loadPageView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: SPACE, folders: [FOLDER] },
    });
  });

  it.each([404, 500])("shows the page without the folders when the folders are %i", async (code) => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [apiError(code, "失敗")],
    });
    expect(await loadPageView(client, "p1")).toEqual({ kind: "ready", data: { page: PAGE, space: SPACE, folders: null } });
  });

  it("moves to the login page when the folders stay 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [unauthorized, unauthorized],
    });
    expect(await loadPageView(client, "p1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("is not found without loading the space when the page is 404", async () => {
    const { client, calls } = setup({ "/api/v1/pages/p1": [apiError(404, "ページが見つかりません")] });
    expect(await loadPageView(client, "p1")).toEqual({ kind: "notFound" });
    expect(calls("/api/v1/spaces/s1")).toBe(0);
    expect(calls("/api/v1/spaces/s1/folders")).toBe(0);
  });

  it.each([404, 500])("shows the page without the space when the space is %i", async (code) => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [apiError(code, "失敗")],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
    });
    expect(await loadPageView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: null, folders: [FOLDER] },
    });
  });

  it("moves to the login page when the space stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [unauthorized, unauthorized],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [] })],
    });
    expect(await loadPageView(client, "p1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not load the space and the folders for an invalid space_id", async () => {
    const { client, fetch } = setup({ "/api/v1/pages/p1": [json(200, { ...PAGE, space_id: "a/b" })] });
    const result = await loadPageView(client, "p1");
    expect(result).toEqual({
      kind: "ready",
      data: { page: { ...PAGE, space_id: "a/b" }, space: null, folders: null },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("loadPageNewView", () => {
  it("shows the space and its folders", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
    });
    expect(await loadPageNewView(client, "s1")).toEqual({ kind: "ready", data: { space: SPACE, folders: [FOLDER] } });
  });

  it("is not found when the space is 404", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/folders": [apiError(404, "スペースが見つかりません")],
    });
    expect(await loadPageNewView(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message when the folders fail", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadPageNewView(client, "s1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("moves to the login page when the folders stay 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [unauthorized, unauthorized],
    });
    expect(await loadPageNewView(client, "s1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadPageNewView(client, "a.b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadPageEditView", () => {
  it("shows the page, its space and the folders of the space", async () => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
    });
    expect(await loadPageEditView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: SPACE, folders: [FOLDER] },
    });
  });

  it("shows the page without the folders when the folders fail", async () => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/folders": [apiError(500, "失敗")],
    });
    expect(await loadPageEditView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: SPACE, folders: null },
    });
  });

  it("is not found without loading the space when the page is 404", async () => {
    const { client, calls } = setup({ "/api/v1/pages/p1": [apiError(404, "ページが見つかりません")] });
    expect(await loadPageEditView(client, "p1")).toEqual({ kind: "notFound" });
    expect(calls("/api/v1/spaces/s1")).toBe(0);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadPageEditView(client, "a.b")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadPageHistoryView", () => {
  it("shows the page, its revisions and its space", async () => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/pages/p1/revisions": [json(200, { revisions: [REVISION_SUMMARY] })],
      "/api/v1/spaces/s1": [json(200, SPACE)],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: SPACE, revisions: [REVISION_SUMMARY] },
    });
  });

  it("is not found without loading the space when the page is 404", async () => {
    const { client, calls } = setup({
      "/api/v1/pages/p1": [apiError(404, "ページが見つかりません")],
      "/api/v1/pages/p1/revisions": [apiError(404, "ページが見つかりません")],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({ kind: "notFound" });
    expect(calls("/api/v1/spaces/s1")).toBe(0);
  });

  it("is an error with the API message when the revisions are 500", async () => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/pages/p1/revisions": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it.each([404, 500])("shows the history without the space when the space is %i", async (code) => {
    const { client } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/pages/p1/revisions": [json(200, { revisions: [] })],
      "/api/v1/spaces/s1": [apiError(code, "失敗")],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({
      kind: "ready",
      data: { page: PAGE, space: null, revisions: [] },
    });
  });

  it("moves to the login page when the revisions stay 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/pages/p1/revisions": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("moves to the login page when the space stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/pages/p1/revisions": [json(200, { revisions: [] })],
      "/api/v1/spaces/s1": [unauthorized, unauthorized],
    });
    expect(await loadPageHistoryView(client, "p1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadPageHistoryView(client, "../users")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadPageRevisionView", () => {
  it("shows the revision with the current page and its space", async () => {
    const { client } = setup({
      "/api/v1/pages/p1/revisions/1": [json(200, REVISION)],
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [json(200, SPACE)],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({
      kind: "ready",
      data: { page: PAGE, space: SPACE, revision: REVISION },
    });
  });

  it("shows the revision without the space when the space cannot be loaded", async () => {
    const { client } = setup({
      "/api/v1/pages/p1/revisions/1": [json(200, REVISION)],
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/api/v1/spaces/s1": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({
      kind: "ready",
      data: { page: PAGE, space: null, revision: REVISION },
    });
  });

  it("is not found when the revision is 404", async () => {
    const { client } = setup({
      "/api/v1/pages/p1/revisions/1": [apiError(404, "この版は見つかりません")],
      "/api/v1/pages/p1": [json(200, PAGE)],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({ kind: "notFound" });
  });

  it("is not found when the page is 404", async () => {
    const { client } = setup({
      "/api/v1/pages/p1/revisions/1": [apiError(404, "ページが見つかりません")],
      "/api/v1/pages/p1": [apiError(404, "ページが見つかりません")],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message when the page is 500", async () => {
    const { client } = setup({
      "/api/v1/pages/p1/revisions/1": [json(200, REVISION)],
      "/api/v1/pages/p1": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({
      kind: "error",
      message: "サーバーでエラーが発生しました",
    });
  });

  it("moves to the login page when the revision stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/pages/p1/revisions/1": [unauthorized, unauthorized],
      "/api/v1/pages/p1": [json(200, PAGE)],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadPageRevisionView(client, "p1", 1)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadPageRevisionView(client, "../users", 1)).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadTrashView", () => {
  const TRASHED: TrashedPage = {
    ...SUMMARY,
    deleted_at: 3,
    deleted_by: "u1",
    purge_after: 3 + 30 * 86_400_000,
  };

  it("shows the space and the pages in its trash", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/trash": [json(200, { pages: [TRASHED] })],
    });
    expect(await loadTrashView(client, "s1")).toEqual({ kind: "ready", data: { space: SPACE, pages: [TRASHED] } });
  });

  it("is not found when the space is 404", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/trash": [apiError(404, "スペースが見つかりません")],
    });
    expect(await loadTrashView(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message when the trash is 500", async () => {
    const { client } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/trash": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadTrashView(client, "s1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("moves to the login page when the trash stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/spaces/s1": [json(200, SPACE)],
      "/api/v1/spaces/s1/trash": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadTrashView(client, "s1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadTrashView(client, "../users")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadFolderView", () => {
  const SPACE_ROUTES = {
    "/api/v1/spaces/s1": [json(200, SPACE)],
    "/api/v1/spaces/s1/folders": [json(200, { folders: [FOLDER] })],
    "/api/v1/spaces/s1/pages": [json(200, { pages: [SUMMARY] })],
  };

  it("shows the folder with its space, the folders and the pages of the space", async () => {
    const { client } = setup({ "/api/v1/folders/f1": [json(200, FOLDER)], ...SPACE_ROUTES });
    expect(await loadFolderView(client, "f1")).toEqual({
      kind: "ready",
      data: { folder: FOLDER, space: SPACE, folders: [FOLDER], pages: [SUMMARY] },
    });
  });

  it("is not found without loading the space when the folder is 404", async () => {
    const { client, calls } = setup({ "/api/v1/folders/f1": [apiError(404, "フォルダが見つかりません")] });
    expect(await loadFolderView(client, "f1")).toEqual({ kind: "notFound" });
    expect(calls("/api/v1/spaces/s1")).toBe(0);
  });

  it.each(["/api/v1/spaces/s1", "/api/v1/spaces/s1/folders", "/api/v1/spaces/s1/pages"])(
    "is an error with the API message when %s is 500",
    async (url) => {
      const routes: Record<string, Reply[]> = { "/api/v1/folders/f1": [json(200, FOLDER)], ...SPACE_ROUTES };
      routes[url] = [apiError(500, "サーバーでエラーが発生しました")];
      const { client } = setup(routes);
      expect(await loadFolderView(client, "f1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
    },
  );

  it("is not found when the space is 404", async () => {
    const { client } = setup({
      "/api/v1/folders/f1": [json(200, FOLDER)],
      "/api/v1/spaces/s1": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/folders": [apiError(404, "スペースが見つかりません")],
      "/api/v1/spaces/s1/pages": [apiError(404, "スペースが見つかりません")],
    });
    expect(await loadFolderView(client, "f1")).toEqual({ kind: "notFound" });
  });

  it("moves to the login page when the folder stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/folders/f1": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadFolderView(client, "f1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("moves to the login page when the pages stay 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/folders/f1": [json(200, FOLDER)],
      ...SPACE_ROUTES,
      "/api/v1/spaces/s1/pages": [unauthorized, unauthorized],
    });
    expect(await loadFolderView(client, "f1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("is an error for an invalid space_id without loading the space", async () => {
    const { client, fetch } = setup({ "/api/v1/folders/f1": [json(200, { ...FOLDER, space_id: "a/b" })] });
    expect(await loadFolderView(client, "f1")).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 200）",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call the API for an invalid ID", async () => {
    const { client, fetch } = setup({});
    expect(await loadFolderView(client, "../users")).toEqual({ kind: "notFound" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("loadSearchView", () => {
  const HIT: SearchHit = { ...SUMMARY, snippet: "…手順…" };
  const PERSONAL: Space = { id: "s2", kind: "personal", name: null, sort_order: 0, archived_at: null, created_at: 1, updated_at: 2 };
  const SEARCH_URL = "/api/v1/search?q=%E6%89%8B%E9%A0%86";

  it("shows the hits with the names of their spaces", async () => {
    const { client } = setup({
      [SEARCH_URL]: [json(200, { hits: [HIT], has_more: true })],
      "/api/v1/spaces": [json(200, { spaces: [SPACE, PERSONAL] })],
    });
    expect(await loadSearchView(client, "  手順 ")).toEqual({
      kind: "ready",
      data: {
        query: "手順",
        hits: [HIT],
        hasMore: true,
        spaceNames: new Map([
          ["s1", "開発"],
          ["s2", "個人スペース"],
        ]),
      },
    });
  });

  it("does not call the API for an empty query", async () => {
    const { client, fetch } = setup({});
    expect(await loadSearchView(client, "   ")).toEqual({
      kind: "ready",
      data: { query: "", hits: [], hasMore: false, spaceNames: new Map() },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is an error with the API message when the search is 400", async () => {
    const { client } = setup({
      [SEARCH_URL]: [apiError(400, "検索語は 1 文字以上 100 文字以下で、改行などの制御文字を含まない文字列にしてください")],
      "/api/v1/spaces": [json(200, { spaces: [SPACE] })],
    });
    expect(await loadSearchView(client, "手順")).toEqual({
      kind: "error",
      message: "検索語は 1 文字以上 100 文字以下で、改行などの制御文字を含まない文字列にしてください",
    });
  });

  it("moves to the login page when the search stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      [SEARCH_URL]: [unauthorized, unauthorized],
      "/api/v1/spaces": [json(200, { spaces: [SPACE] })],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadSearchView(client, "手順")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("shows the hits without space names when the spaces fail", async () => {
    const { client } = setup({
      [SEARCH_URL]: [json(200, { hits: [HIT], has_more: false })],
      "/api/v1/spaces": [apiError(500, "サーバーでエラーが発生しました")],
    });
    expect(await loadSearchView(client, "手順")).toEqual({
      kind: "ready",
      data: { query: "手順", hits: [HIT], hasMore: false, spaceNames: new Map() },
    });
  });

  it("moves to the login page when the spaces stay 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      [SEARCH_URL]: [json(200, { hits: [HIT], has_more: false })],
      "/api/v1/spaces": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadSearchView(client, "手順")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("loadUsersView", () => {
  const USER: User = {
    id: "u1",
    email: "a@example.com",
    name: null,
    role: "admin",
    created_at: 1,
    last_login_at: null,
  };

  it("shows the users and the auth mode", async () => {
    const { client } = setup({ "/api/v1/users": [json(200, { users: [USER], auth_mode: "oidc" })] });
    expect(await loadUsersView(client)).toEqual({ kind: "ready", data: { users: [USER], authMode: "oidc" } });
  });

  it("is an error with the API message on 403", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(403, "管理者の権限が必要です")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "管理者の権限が必要です" });
  });

  it("is an error on 404", async () => {
    const { client } = setup({ "/api/v1/users": [apiError(404, "見つかりません")] });
    expect(await loadUsersView(client)).toEqual({ kind: "error", message: "見つかりません" });
  });

  it("moves to the login page when the list stays 401 after the refresh", async () => {
    const { client, redirectToLogin } = setup({
      "/api/v1/users": [unauthorized, unauthorized],
      "/auth/refresh": [() => new Response(null, { status: 401 })],
    });
    expect(await loadUsersView(client)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("loadArchiveView", () => {
  const ARCHIVED: Space = { ...SPACE, archived_at: 3 };

  it("shows the archived spaces", async () => {
    const { client } = setup({ "/api/v1/spaces?archived=true": [json(200, { spaces: [ARCHIVED] })] });
    expect(await loadArchiveView(client)).toEqual({ kind: "ready", data: [ARCHIVED] });
  });

  it("is an error with the API message on 500", async () => {
    const { client } = setup({ "/api/v1/spaces?archived=true": [apiError(500, "サーバーでエラーが発生しました")] });
    expect(await loadArchiveView(client)).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });
});
