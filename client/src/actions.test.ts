import { describe, expect, it, vi } from "vitest";
import type { Attachment, Page, Space, User } from "../../src/api/types";
import {
  archiveSpace,
  changeUserRole,
  createFolder,
  createPage,
  createSpace,
  createUser,
  deleteAttachment,
  deleteFolder,
  deleteSpace,
  deleteUser,
  moveFolder,
  movePage,
  purgeTrashedPage,
  resetUserPassword,
  restoreRevision,
  restoreTrashedPage,
  revokeUserSessions,
  setTopPage,
  trashPage,
  unarchiveSpace,
  updateFolder,
  updatePage,
  updateSpace,
  uploadAttachment,
} from "./actions";
import { createApiClient, createApiFetch } from "./api";

const PAGE: Page = {
  id: "p1",
  space_id: "s1",
  folder_id: null,
  title: "手順",
  version: 4,
  created_by: "u1",
  updated_by: "u1",
  created_at: 1,
  updated_at: 2,
  body: "# 手順",
};

const RESTORE_URL = "/api/v1/pages/p1/revisions/2/restore";

// fetch that answers expectedUrl (the restore URL unless given) with reply. /auth/refresh answers 401
// unless given, so a 401 ends at the login page.
function setup(reply: () => Response | Promise<Response>, refreshStatus = 401, expectedUrl = RESTORE_URL) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url === "/auth/refresh") return new Response(null, { status: refreshStatus });
    if (url !== expectedUrl) throw new Error(`unexpected fetch: ${url}`);
    return reply();
  });
  const redirectToLogin = vi.fn<(url: string) => void>();
  const client = createApiClient(createApiFetch({ fetch, redirectToLogin, currentPath: () => "/" }));
  return { client, fetch, redirectToLogin };
}

function apiError(code: number, message: string): () => Response {
  return () => Response.json({ error: { code: "error", message } }, { status: code });
}

describe("restoreRevision", () => {
  it("sends the current version and is ok on 200", async () => {
    const { client, fetch } = setup(() => Response.json({ ...PAGE, version: 5 }));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 4 });
  });

  it("is a conflict on 409", async () => {
    const { client } = setup(apiError(409, "ページが他の人に更新されています。最新の内容を取得してからやり直してください"));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "conflict" });
  });

  it.each([
    [404, "この版は見つかりません。古い版は新しい 20 版を残して削除されます"],
    [500, "サーバーでエラーが発生しました"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "error", message });
  });

  it("is an error with a fixed message when the error is not JSON", async () => {
    const { client } = setup(() => new Response("Bad Gateway", { status: 502 }));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 502）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "unknown" });
  });

  it("is unknown when the token refresh fails", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインしてください"), 500);
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "unknown" });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインしてください"));
    expect(await restoreRevision(client, "p1", 2, 4)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("trashPage", () => {
  const url = "/api/v1/pages/p1";

  it("sends DELETE and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await trashPage(client, "p1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await trashPage(client, "p1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 500", async () => {
    const { client } = setup(apiError(500, "サーバーでエラーが発生しました"), 401, url);
    expect(await trashPage(client, "p1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await trashPage(client, "p1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await trashPage(client, "p1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("restoreTrashedPage", () => {
  const url = "/api/v1/pages/p1/restore";

  it("sends POST and returns the page on 200", async () => {
    const { client, fetch } = setup(() => Response.json(PAGE), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "ok", page: PAGE });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is a conflict on 409", async () => {
    const { client } = setup(apiError(409, "このページはゴミ箱にありません"), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "conflict" });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 500", async () => {
    const { client } = setup(apiError(500, "サーバーでエラーが発生しました"), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await restoreTrashedPage(client, "p1")).toEqual({ kind: "redirecting" });
  });
});

describe("purgeTrashedPage", () => {
  const url = "/api/v1/pages/p1/permanent";

  it("sends DELETE and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is forbidden with the API message on 403", async () => {
    const message = "個人スペースのページは完全に削除できません。30 日たつと自動で削除されます";
    const { client } = setup(apiError(403, message), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "forbidden", message });
  });

  it("is a conflict on 409", async () => {
    const { client } = setup(apiError(409, "ゴミ箱にないページは完全に削除できません。先にゴミ箱へ移してください"), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "conflict" });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 500", async () => {
    const { client } = setup(apiError(500, "サーバーでエラーが発生しました"), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await purgeTrashedPage(client, "p1")).toEqual({ kind: "redirecting" });
  });
});

describe("createPage", () => {
  const url = "/api/v1/spaces/s1/pages";
  const input = { title: " 手順 ", body: "# 手順", folderId: "f1" };

  it("sends the title as typed with the body and the folder, and returns the page on 201", async () => {
    const { client, fetch } = setup(() => Response.json(PAGE, { status: 201 }), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({ kind: "ok", page: PAGE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: " 手順 ", body: "# 手順", folder_id: "f1" });
  });

  it("sends a null folder for the top level", async () => {
    const { client, fetch } = setup(() => Response.json(PAGE, { status: 201 }), 401, url);
    await createPage(client, "s1", { ...input, folderId: null });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ folder_id: null });
  });

  it("is an error when the created page is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "スペースが見つかりません"), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "タイトルは1〜200文字で入力してください"],
    [400, "フォルダが見つかりません"],
    [500, "サーバーでエラーが発生しました"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createPage(client, "s1", input)).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("updatePage", () => {
  const url = "/api/v1/pages/p1";

  it("sends the version with the changes and returns the page on 200", async () => {
    const { client, fetch } = setup(() => Response.json({ ...PAGE, version: 5 }), 401, url);
    expect(await updatePage(client, "p1", 4, { body: "# 新しい手順", folder_id: null })).toEqual({
      kind: "ok",
      page: { ...PAGE, version: 5 },
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 4, body: "# 新しい手順", folder_id: null });
  });

  it("is a conflict on 409", async () => {
    const { client } = setup(apiError(409, "ページが他の人に更新されています"), 401, url);
    expect(await updatePage(client, "p1", 4, { title: "B" })).toEqual({ kind: "conflict" });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await updatePage(client, "p1", 4, { title: "B" })).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "本文が大きすぎます"],
    [500, "サーバーでエラーが発生しました"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await updatePage(client, "p1", 4, { title: "B" })).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await updatePage(client, "p1", 4, { title: "B" })).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await updatePage(client, "p1", 4, { title: "B" })).toEqual({ kind: "redirecting" });
  });
});

describe("createFolder", () => {
  const url = "/api/v1/spaces/s1/folders";

  it("sends the name and the parent and is ok on 201", async () => {
    const { client, fetch } = setup(() => Response.json({}, { status: 201 }), 401, url);
    expect(await createFolder(client, "s1", { name: "資料", parentId: "f1" })).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "資料", parent_id: "f1" });
  });

  it("sends a null parent for the top level", async () => {
    const { client, fetch } = setup(() => Response.json({}, { status: 201 }), 401, url);
    await createFolder(client, "s1", { name: "資料", parentId: null });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ name: "資料", parent_id: null });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "スペースが見つかりません"), 401, url);
    expect(await createFolder(client, "s1", { name: "資料", parentId: null })).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "フォルダ名を入力してください"],
    [400, "親フォルダが見つかりません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createFolder(client, "s1", { name: "", parentId: null })).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createFolder(client, "s1", { name: "資料", parentId: null })).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createFolder(client, "s1", { name: "資料", parentId: null })).toEqual({ kind: "redirecting" });
  });
});

describe("updateFolder", () => {
  const url = "/api/v1/folders/f1";

  it("sends only the given fields and is ok on 200", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await updateFolder(client, "f1", { name: "新しい名前" })).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "新しい名前" });
  });

  it("sends a null parent to move the folder to the top level", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await updateFolder(client, "f1", { parent_id: null })).toEqual({ kind: "ok" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ parent_id: null });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "フォルダが見つかりません"), 401, url);
    expect(await updateFolder(client, "f1", { name: "a" })).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "移動先のフォルダが見つかりません"],
    [409, "フォルダをその中のフォルダへは移動できません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await updateFolder(client, "f1", { parent_id: "f2" })).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await updateFolder(client, "f1", { name: "a" })).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await updateFolder(client, "f1", { name: "a" })).toEqual({ kind: "redirecting" });
  });
});

describe("deleteFolder", () => {
  const url = "/api/v1/folders/f1";

  it("sends DELETE and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteFolder(client, "f1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "フォルダが見つかりません"), 401, url);
    expect(await deleteFolder(client, "f1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const message = "中にページやフォルダがあるフォルダは削除できません";
    const { client } = setup(apiError(409, message), 401, url);
    expect(await deleteFolder(client, "f1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await deleteFolder(client, "f1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await deleteFolder(client, "f1")).toEqual({ kind: "redirecting" });
  });
});

describe("movePage", () => {
  const url = "/api/v1/pages/p1/move";
  const input = { version: 4, spaceId: "s2", folderId: null };

  it("sends the version, the space and the folder and returns the page on 200", async () => {
    const { client, fetch } = setup(() => Response.json({ ...PAGE, space_id: "s2", version: 5 }), 401, url);
    expect(await movePage(client, "p1", { version: 4, spaceId: "s2", folderId: "f1" })).toEqual({
      kind: "ok",
      page: { ...PAGE, space_id: "s2", version: 5 },
    });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 4, space_id: "s2", folder_id: "f1" });
  });

  it("sends a null folder for the top level", async () => {
    const { client, fetch } = setup(() => Response.json(PAGE), 401, url);
    await movePage(client, "p1", input);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ version: 4, space_id: "s2", folder_id: null });
  });

  it("is a conflict on 409", async () => {
    const { client } = setup(apiError(409, "ページが他の人に更新されています"), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({ kind: "conflict" });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "移動先のスペースが見つかりません"],
    [400, "移動先のフォルダが見つかりません"],
    [500, "サーバーでエラーが発生しました"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({ kind: "error", message });
  });

  it("is an error with a fixed message when the page is not JSON", async () => {
    const { client } = setup(() => new Response("ok", { status: 200 }), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 200）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await movePage(client, "p1", input)).toEqual({ kind: "redirecting" });
  });
});

describe("moveFolder", () => {
  const url = "/api/v1/folders/f1/move";
  const input = { spaceId: "s2", parentId: null };

  it("sends the space and the parent and is ok on 200", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await moveFolder(client, "f1", { spaceId: "s2", parentId: "f2" })).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ space_id: "s2", parent_id: "f2" });
  });

  it("sends a null parent for the top level", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    await moveFolder(client, "f1", input);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ space_id: "s2", parent_id: null });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "フォルダが見つかりません"), 401, url);
    expect(await moveFolder(client, "f1", input)).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "移動先のスペースが見つかりません"],
    [409, "フォルダを自分自身やその中のフォルダへは移せません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await moveFolder(client, "f1", input)).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await moveFolder(client, "f1", input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await moveFolder(client, "f1", input)).toEqual({ kind: "redirecting" });
  });
});

describe("createSpace", () => {
  const url = "/api/v1/spaces";
  const input = { kind: "admin", name: "運用" } as const;
  const SPACE: Space = { id: "s2", kind: "admin", name: "運用", sort_order: 0, archived_at: null, created_at: 1, updated_at: 1 };

  it("sends the kind and the name and is ok with the space on 201", async () => {
    const { client, fetch } = setup(() => Response.json(SPACE, { status: 201 }), 401, url);
    expect(await createSpace(client, input)).toEqual({ kind: "ok", space: SPACE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "admin", name: "運用" });
  });

  it("is an error when the created space is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createSpace(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it.each([
    [400, "スペースの名前は 1 文字以上 100 文字以下で、改行を含まない文字列にしてください"],
    [403, "管理者の権限が必要です"],
    [409, "この名前のスペースはすでにあります（アーカイブされたスペースを含みます）"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createSpace(client, input)).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createSpace(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createSpace(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe("setTopPage", () => {
  const url = "/api/v1/top-page";

  it("sends the page ID and is ok with the page on 200", async () => {
    const { client, fetch } = setup(() => Response.json({ page: PAGE }), 401, url);
    expect(await setTopPage(client, "p1")).toEqual({ kind: "ok", page: PAGE });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ page_id: "p1" });
  });

  it("sends null to clear the setting and is ok with null", async () => {
    const { client, fetch } = setup(() => Response.json({ page: null }), 401, url);
    expect(await setTopPage(client, null)).toEqual({ kind: "ok", page: null });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ page_id: null });
  });

  it("is an error when the response is not JSON", async () => {
    const { client } = setup(() => new Response("ok", { status: 200 }), 401, url);
    expect(await setTopPage(client, "p1")).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 200）",
    });
  });

  it.each([
    [400, "トップに表示できるのは全員スペースのページだけです"],
    [403, "管理者の権限が必要です"],
    [404, "ページが見つかりません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await setTopPage(client, "p1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await setTopPage(client, "p1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await setTopPage(client, null)).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => Response.json({ page: null }), 401, url);
    expect(await setTopPage(client, "../users")).toEqual({ kind: "error", message: "ページが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("updateSpace", () => {
  const url = "/api/v1/spaces/s1";
  const fields = { name: "a", sortOrder: 1 };

  it("sends the name and the sort_order in one PATCH and is ok on 200", async () => {
    const { client, fetch } = setup(() => Response.json({}), 401, url);
    expect(await updateSpace(client, "s1", { name: "新しい名前", sortOrder: -3 })).toEqual({ kind: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "新しい名前", sort_order: -3 });
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "スペースが見つかりません"), 401, url);
    expect(await updateSpace(client, "s1", fields)).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const message = "この名前のスペースはすでにあります（アーカイブされたスペースを含みます）";
    const { client } = setup(apiError(409, message), 401, url);
    expect(await updateSpace(client, "s1", fields)).toEqual({ kind: "error", message });
  });

  it("is an error with the API message on 400", async () => {
    const message = "表示順は -1000000 以上 1000000 以下の整数にしてください";
    const { client } = setup(apiError(400, message), 401, url);
    expect(await updateSpace(client, "s1", fields)).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await updateSpace(client, "s1", fields)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await updateSpace(client, "s1", fields)).toEqual({ kind: "redirecting" });
  });
});

describe("deleteSpace", () => {
  const url = "/api/v1/spaces/s1";

  it("sends DELETE and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteSpace(client, "s1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "スペースが見つかりません"), 401, url);
    expect(await deleteSpace(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 409", async () => {
    const message =
      "ページ（ゴミ箱のページを含む）かフォルダが残っているスペースは削除できません。中身を移すか削除してから消してください";
    const { client } = setup(apiError(409, message), 401, url);
    expect(await deleteSpace(client, "s1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await deleteSpace(client, "s1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await deleteSpace(client, "s1")).toEqual({ kind: "redirecting" });
  });
});

describe("uploadAttachment", () => {
  const url = "/api/v1/pages/p1/attachments?filename=%E5%86%99%E7%9C%9F+1.png";
  const ATTACHMENT: Attachment = {
    id: "a1",
    page_id: "p1",
    filename: "写真 1.png",
    content_type: "image/png",
    size: 3,
    created_by: "u1",
    created_at: 1,
    url: "/api/v1/attachments/a1",
    markdown: "![写真 1.png](/api/v1/attachments/a1)",
  };

  function file(size = 3): File {
    return new File([new Uint8Array(size)], "写真 1.png", { type: "image/png" });
  }

  it("sends the file itself with its name and returns the attachment on 201", async () => {
    const { client, fetch } = setup(() => Response.json(ATTACHMENT, { status: 201 }), 401, url);
    const sent = file();
    expect(await uploadAttachment(client, "p1", sent)).toEqual({ kind: "ok", attachment: ATTACHMENT });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(sent);
  });

  it("sends the same file again after refreshing the login", async () => {
    let calls = 0;
    const { client, fetch } = setup(
      () => (++calls === 1 ? apiError(401, "ログインが必要です")() : Response.json(ATTACHMENT, { status: 201 })),
      204,
      url,
    );
    const sent = file();
    expect(await uploadAttachment(client, "p1", sent)).toEqual({ kind: "ok", attachment: ATTACHMENT });
    const uploads = fetch.mock.calls.filter(([input]) => String(input) === url);
    expect(uploads.map(([, init]) => init?.body)).toEqual([sent, sent]);
  });

  it.each([
    ["an empty file", 0, "空のファイルは添付できません"],
    ["a file over 10MB", 10 * 1024 * 1024 + 1, "添付できるファイルは 10MB までです"],
  ])("rejects %s without sending", async (_, size, message) => {
    const { client, fetch } = setup(() => Response.json(ATTACHMENT, { status: 201 }), 401, url);
    expect(await uploadAttachment(client, "p1", file(size))).toEqual({ kind: "error", message });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ページが見つかりません"), 401, url);
    expect(await uploadAttachment(client, "p1", file())).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です"],
    [413, "添付できるファイルは 10MB までです"],
    [500, "サーバーでエラーが発生しました"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await uploadAttachment(client, "p1", file())).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await uploadAttachment(client, "p1", file())).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインが必要です"), 401, url);
    expect(await uploadAttachment(client, "p1", file())).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("deleteAttachment", () => {
  const url = "/api/v1/attachments/a1";

  it("sends DELETE and is ok on 204", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await deleteAttachment(client, "a1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "添付ファイルが見つかりません"), 401, url);
    expect(await deleteAttachment(client, "a1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 500", async () => {
    const { client } = setup(apiError(500, "サーバーでエラーが発生しました"), 401, url);
    expect(await deleteAttachment(client, "a1")).toEqual({ kind: "error", message: "サーバーでエラーが発生しました" });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await deleteAttachment(client, "a1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client, redirectToLogin } = setup(apiError(401, "ログインが必要です"), 401, url);
    expect(await deleteAttachment(client, "a1")).toEqual({ kind: "redirecting" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("createUser", () => {
  const url = "/api/v1/users";
  const input = { email: "new@example.com", name: null, password: "correct horse battery", role: "member" } as const;
  const USER: User = {
    id: "u2",
    email: "new@example.com",
    name: null,
    role: "member",
    created_at: 1,
    last_login_at: null,
  };

  it("sends the input and is ok with the user on 201", async () => {
    const { client, fetch } = setup(() => Response.json(USER, { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "ok", user: USER });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("is an error when the created user is not JSON", async () => {
    const { client } = setup(() => new Response("created", { status: 201 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 201）",
    });
  });

  it.each([
    [400, "パスワードは 12 文字以上 256 文字以下にしてください"],
    [404, "見つかりません"],
    [409, "このメールアドレスはすでに使われています"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "error", message });
  });

  it("is an error with a fixed message when the error is not JSON", async () => {
    const { client } = setup(() => new Response("Bad Gateway", { status: 502 }), 401, url);
    expect(await createUser(client, input)).toEqual({
      kind: "error",
      message: "サーバーから予期しない応答がありました（HTTP 502）",
    });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await createUser(client, input)).toEqual({ kind: "redirecting" });
  });
});

describe.each([
  {
    name: "changeUserRole",
    url: "/api/v1/users/u1",
    method: "PATCH",
    body: { role: "member" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => changeUserRole(client, id, "member"),
    okStatus: 200,
  },
  {
    name: "resetUserPassword",
    url: "/api/v1/users/u1/password",
    method: "POST",
    body: { password: "a brand new password" },
    call: (client: Parameters<typeof deleteUser>[0], id: string) => resetUserPassword(client, id, "a brand new password"),
    okStatus: 204,
  },
  {
    name: "revokeUserSessions",
    url: "/api/v1/users/u1/revoke-sessions",
    method: "POST",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => revokeUserSessions(client, id),
    okStatus: 204,
  },
  {
    name: "deleteUser",
    url: "/api/v1/users/u1",
    method: "DELETE",
    body: undefined,
    call: (client: Parameters<typeof deleteUser>[0], id: string) => deleteUser(client, id),
    okStatus: 204,
  },
])("$name", ({ url, method, body, call, okStatus }) => {
  it("sends the request and is ok", async () => {
    const { client, fetch } = setup(
      () => (okStatus === 204 ? new Response(null, { status: 204 }) : Response.json({})),
      401,
      url,
    );
    expect(await call(client, "u1")).toEqual({ kind: "ok" });
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe(method);
    if (body !== undefined) expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "ユーザーが見つかりません"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "notFound" });
  });

  it.each([
    [400, "自分自身は削除できません"],
    [403, "管理者の権限が必要です"],
    [409, "最後の管理者は削除できません"],
  ])("is an error with the API message on %i", async (code, message) => {
    const { client } = setup(apiError(code, message), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "unknown" });
  });

  it("is redirecting when login is required", async () => {
    const { client } = setup(apiError(401, "ログインしてください"), 401, url);
    expect(await call(client, "u1")).toEqual({ kind: "redirecting" });
  });

  it("is an error without sending for an invalid ID", async () => {
    const { client, fetch } = setup(() => new Response(null, { status: 204 }), 401, url);
    expect(await call(client, "../spaces/s1")).toEqual({ kind: "error", message: "ユーザーが見つかりません" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each([
  ["archiveSpace", archiveSpace, "/api/v1/spaces/s1/archive"],
  ["unarchiveSpace", unarchiveSpace, "/api/v1/spaces/s1/unarchive"],
] as const)("%s", (_name, action, url) => {
  const SPACE: Space = {
    id: "s1",
    kind: "everyone",
    name: "開発",
    sort_order: 0,
    archived_at: null,
    created_at: 1,
    updated_at: 1,
  };

  it("sends POST and is ok on 200", async () => {
    const { client, fetch } = setup(() => Response.json(SPACE), 401, url);
    expect(await action(client, "s1")).toEqual({ kind: "ok" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is not found on 404", async () => {
    const { client } = setup(apiError(404, "スペースが見つかりません"), 401, url);
    expect(await action(client, "s1")).toEqual({ kind: "notFound" });
  });

  it("is an error with the API message on 403", async () => {
    const message = "個人スペースはアーカイブできません";
    const { client } = setup(apiError(403, message), 401, url);
    expect(await action(client, "s1")).toEqual({ kind: "error", message });
  });

  it("is unknown when fetch rejects", async () => {
    const { client } = setup(() => Promise.reject(new TypeError("Failed to fetch")), 401, url);
    expect(await action(client, "s1")).toEqual({ kind: "unknown" });
  });
});

// A 409 of a write to a page is a conflict, except space_archived, which is an error with the server's message.
describe("409 space_archived", () => {
  const message = "アーカイブされたスペースは編集できません。アーカイブを解除してから操作してください";
  const archived = () => Response.json({ error: { code: "space_archived", message } }, { status: 409 });
  const conflict = () => Response.json({ error: { code: "version_conflict", message: "更新されています" } }, { status: 409 });
  const cases = [
    ["restoreRevision", RESTORE_URL, (client: Client) => restoreRevision(client, "p1", 2, 4)],
    ["restoreTrashedPage", "/api/v1/pages/p1/restore", (client: Client) => restoreTrashedPage(client, "p1")],
    ["purgeTrashedPage", "/api/v1/pages/p1/permanent", (client: Client) => purgeTrashedPage(client, "p1")],
    ["updatePage", "/api/v1/pages/p1", (client: Client) => updatePage(client, "p1", 4, { title: "B" })],
    [
      "movePage",
      "/api/v1/pages/p1/move",
      (client: Client) => movePage(client, "p1", { version: 4, spaceId: "s2", folderId: null }),
    ],
  ] as const;

  it.each(cases)("%s is an error with the message on space_archived", async (_name, url, call) => {
    const { client } = setup(archived, 401, url);
    expect(await call(client)).toEqual({ kind: "error", message });
  });

  it.each(cases)("%s is still a conflict on another 409", async (_name, url, call) => {
    const { client } = setup(conflict, 401, url);
    expect(await call(client)).toEqual({ kind: "conflict" });
  });
});

type Client = ReturnType<typeof createApiClient>;
