import { useEffect, useState } from "react";
import type {
  Attachment,
  Folder,
  Page,
  PageRevision,
  PageRevisionSummary,
  PageSummary,
  SearchHit,
  Space,
  TrashedPage,
  User,
  UserList,
} from "../../src/api/types";
import {
  LoginRequiredError,
  type createApiClient,
  responseErrorMessage,
  unexpectedResponseMessage,
} from "./api";
import { spaceDisplayName } from "./format";
import { isValidId } from "./router";

export type ApiClient = ReturnType<typeof createApiClient>;

// The state of a screen that loads its own data.
export type ViewState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // The API answered 404. Spaces and pages the user cannot access are also 404.
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "redirecting" };

export type Loaded<T> = Exclude<ViewState<T>, { kind: "loading" }>;

export const CONNECTION_ERROR = "サーバーに接続できませんでした";

type Result<T> =
  | { kind: "ok"; value: T }
  | { kind: "notFound"; message: string }
  | { kind: "error"; message: string }
  | { kind: "redirecting" };

type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

// The JSON body of the ok responses of an hc() call.
type OkJson<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

// Reads the JSON body of an ok response. null if it is not JSON.
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Calls the API and sorts the outcome. Never rejects.
async function request<R extends JsonResponse>(call: () => Promise<R>): Promise<Result<OkJson<R>>> {
  let res: R;
  try {
    res = await call();
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "error", message: CONNECTION_ERROR };
  }
  if (res.status === 404) return { kind: "notFound", message: await responseErrorMessage(res) };
  if (!res.ok) return { kind: "error", message: await responseErrorMessage(res) };
  const body = await readJson(res);
  if (body === null) return { kind: "error", message: unexpectedResponseMessage(res.status) };
  // res.ok is true here, so the body is one of the ok bodies.
  return { kind: "ok", value: body as OkJson<R> };
}

// Combines the results of the calls of one screen, at least one of which is not ok:
// redirecting > not found > error.
function failure(results: Result<unknown>[]): Loaded<never> {
  if (results.some((r) => r.kind === "redirecting")) return { kind: "redirecting" };
  if (results.some((r) => r.kind === "notFound")) return { kind: "notFound" };
  for (const r of results) {
    if (r.kind === "error") return { kind: "error", message: r.message };
  }
  throw new Error("failure() needs a result that is not ok");
}

export async function loadMe(client: ApiClient): Promise<Loaded<User>> {
  const me = await request(() => client.api.v1.me.$get());
  if (me.kind === "redirecting") return me;
  // There is no "not found" for the signed-in user; show it as an error.
  if (me.kind === "notFound" || me.kind === "error") return { kind: "error", message: me.message };
  return { kind: "ready", data: me.value };
}

// topPage is the page shown above the spaces, null when there is none. topPageError is true when it could
// not be loaded; the spaces are shown anyway.
export type HomeData = { spaces: Space[]; topPage: Page | null; topPageError: boolean };

export async function loadHomeView(client: ApiClient): Promise<Loaded<HomeData>> {
  const [list, top] = await Promise.all([
    request(() => client.api.v1.spaces.$get({ query: {} })),
    request(() => client.api.v1["top-page"].$get()),
  ]);
  if (list.kind === "redirecting") return list;
  if (top.kind === "redirecting") return top;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return {
    kind: "ready",
    data: {
      spaces: list.value.spaces,
      topPage: top.kind === "ok" ? top.value.page : null,
      topPageError: top.kind !== "ok",
    },
  };
}

// folders are all the folders of the space, as a flat list.
export type SpaceData = { space: Space; folders: Folder[]; pages: PageSummary[] };

export async function loadSpaceView(client: ApiClient, id: string): Promise<Loaded<SpaceData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const param = { param: { id } };
  const [space, folders, pages] = await Promise.all([
    request(() => client.api.v1.spaces[":id"].$get(param)),
    request(() => client.api.v1.spaces[":id"].folders.$get(param)),
    request(() => client.api.v1.spaces[":id"].pages.$get(param)),
  ]);
  if (space.kind === "ok" && folders.kind === "ok" && pages.kind === "ok") {
    return {
      kind: "ready",
      data: { space: space.value, folders: folders.value.folders, pages: pages.value.pages },
    };
  }
  return failure([space, folders, pages]);
}

export type TrashData = { space: Space; pages: TrashedPage[] };

export async function loadTrashView(client: ApiClient, id: string): Promise<Loaded<TrashData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const param = { param: { id } };
  const [space, trash] = await Promise.all([
    request(() => client.api.v1.spaces[":id"].$get(param)),
    request(() => client.api.v1.spaces[":id"].trash.$get(param)),
  ]);
  if (space.kind === "ok" && trash.kind === "ok") {
    return { kind: "ready", data: { space: space.value, pages: trash.value.pages } };
  }
  return failure([space, trash]);
}

// folders and pages are all those of the space; the screen picks the ones in the folder.
export type FolderData = { folder: Folder; space: Space; folders: Folder[]; pages: PageSummary[] };

export async function loadFolderView(client: ApiClient, id: string): Promise<Loaded<FolderData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const folder = await request(() => client.api.v1.folders[":id"].$get({ param: { id } }));
  if (folder.kind !== "ok") return failure([folder]);
  // The rest needs space_id from the folder, so it is loaded after it.
  const spaceId = folder.value.space_id;
  if (!isValidId(spaceId)) return { kind: "error", message: unexpectedResponseMessage(200) };
  const param = { param: { id: spaceId } };
  const [space, folders, pages] = await Promise.all([
    request(() => client.api.v1.spaces[":id"].$get(param)),
    request(() => client.api.v1.spaces[":id"].folders.$get(param)),
    request(() => client.api.v1.spaces[":id"].pages.$get(param)),
  ]);
  if (space.kind === "ok" && folders.kind === "ok" && pages.kind === "ok") {
    return {
      kind: "ready",
      data: { folder: folder.value, space: space.value, folders: folders.value.folders, pages: pages.value.pages },
    };
  }
  return failure([space, folders, pages]);
}

// space and folders are null when they could not be loaded; the page is shown anyway.
export type PageData = { page: Page; space: Space | null; folders: Folder[] | null };

export async function loadPageView(client: ApiClient, id: string): Promise<Loaded<PageData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const page = await request(() => client.api.v1.pages[":id"].$get({ param: { id } }));
  if (page.kind !== "ok") return failure([page]);
  // The space and its folders need space_id from the page, so they are loaded after it.
  const spaceId = page.value.space_id;
  if (!isValidId(spaceId)) return { kind: "ready", data: { page: page.value, space: null, folders: null } };
  const param = { param: { id: spaceId } };
  const [space, folders] = await Promise.all([
    request(() => client.api.v1.spaces[":id"].$get(param)),
    request(() => client.api.v1.spaces[":id"].folders.$get(param)),
  ]);
  if (space.kind === "redirecting") return space;
  if (folders.kind === "redirecting") return folders;
  return {
    kind: "ready",
    data: {
      page: page.value,
      space: space.kind === "ok" ? space.value : null,
      folders: folders.kind === "ok" ? folders.value.folders : null,
    },
  };
}

// The page form needs every folder of the space to choose from, so both are required.
export type PageNewData = { space: Space; folders: Folder[] };

export async function loadPageNewView(client: ApiClient, spaceId: string): Promise<Loaded<PageNewData>> {
  if (!isValidId(spaceId)) return { kind: "notFound" };
  const param = { param: { id: spaceId } };
  const [space, folders] = await Promise.all([
    request(() => client.api.v1.spaces[":id"].$get(param)),
    request(() => client.api.v1.spaces[":id"].folders.$get(param)),
  ]);
  if (space.kind === "ok" && folders.kind === "ok") {
    return { kind: "ready", data: { space: space.value, folders: folders.value.folders } };
  }
  return failure([space, folders]);
}

// The same data as the page screen. When folders is null the page can be edited, but not moved.
export function loadPageEditView(client: ApiClient, id: string): Promise<Loaded<PageData>> {
  return loadPageView(client, id);
}

// space is null when it could not be loaded; the history is shown anyway.
export type PageHistoryData = { page: Page; space: Space | null; revisions: PageRevisionSummary[] };

export async function loadPageHistoryView(client: ApiClient, id: string): Promise<Loaded<PageHistoryData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const param = { param: { id } };
  const [page, list] = await Promise.all([
    request(() => client.api.v1.pages[":id"].$get(param)),
    request(() => client.api.v1.pages[":id"].revisions.$get(param)),
  ]);
  if (page.kind !== "ok" || list.kind !== "ok") return failure([page, list]);
  // The space needs space_id from the page, so it is loaded after it.
  const spaceId = page.value.space_id;
  const data = { page: page.value, revisions: list.value.revisions };
  if (!isValidId(spaceId)) return { kind: "ready", data: { ...data, space: null } };
  const space = await request(() => client.api.v1.spaces[":id"].$get({ param: { id: spaceId } }));
  if (space.kind === "redirecting") return space;
  return { kind: "ready", data: { ...data, space: space.kind === "ok" ? space.value : null } };
}

// page is the current page; restoring needs its version. space is null when it could not be loaded; the
// revision is shown anyway.
export type PageRevisionData = { page: Page; space: Space | null; revision: PageRevision };

export async function loadPageRevisionView(
  client: ApiClient,
  id: string,
  version: number,
): Promise<Loaded<PageRevisionData>> {
  if (!isValidId(id)) return { kind: "notFound" };
  const [revision, page] = await Promise.all([
    request(() => client.api.v1.pages[":id"].revisions[":version"].$get({ param: { id, version: String(version) } })),
    request(() => client.api.v1.pages[":id"].$get({ param: { id } })),
  ]);
  if (revision.kind !== "ok" || page.kind !== "ok") return failure([revision, page]);
  // The space needs space_id from the page, so it is loaded after it.
  const spaceId = page.value.space_id;
  const data = { page: page.value, revision: revision.value };
  if (!isValidId(spaceId)) return { kind: "ready", data: { ...data, space: null } };
  const space = await request(() => client.api.v1.spaces[":id"].$get({ param: { id: spaceId } }));
  if (space.kind === "redirecting") return space;
  return { kind: "ready", data: { ...data, space: space.kind === "ok" ? space.value : null } };
}

// The archived spaces the user can access, for the archive screen.
export async function loadArchiveView(client: ApiClient): Promise<Loaded<Space[]>> {
  const list = await request(() => client.api.v1.spaces.$get({ query: { archived: "true" } }));
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: list.value.spaces };
}

// query is trimmed. spaceNames maps space_id to the display name; it is empty when the spaces
// could not be loaded, and the results are shown anyway.
export type SearchData = { query: string; hits: SearchHit[]; hasMore: boolean; spaceNames: Map<string, string> };

export async function loadSearchView(client: ApiClient, query: string): Promise<Loaded<SearchData>> {
  const q = query.trim();
  // Only an empty query is checked here; the server checks the rest and its message is shown.
  if (q === "") return { kind: "ready", data: { query: "", hits: [], hasMore: false, spaceNames: new Map() } };
  const [result, list] = await Promise.all([
    request(() => client.api.v1.search.$get({ query: { q } })),
    request(() => client.api.v1.spaces.$get({ query: {} })),
  ]);
  if (result.kind === "redirecting") return result;
  // The search itself is never missing; a 404 here is an unexpected response.
  if (result.kind === "notFound" || result.kind === "error") return { kind: "error", message: result.message };
  if (list.kind === "redirecting") return list;
  const spaceNames = new Map(
    list.kind === "ok" ? list.value.spaces.map((space) => [space.id, spaceDisplayName(space)] as const) : [],
  );
  return { kind: "ready", data: { query: q, hits: result.value.hits, hasMore: result.value.has_more, spaceNames } };
}

export type UsersData = { users: User[]; authMode: UserList["auth_mode"] };

// Admins only. A 403 (a member opened the URL) is shown with the server's message.
export async function loadUsersView(client: ApiClient): Promise<Loaded<UsersData>> {
  const list = await request(() => client.api.v1.users.$get());
  if (list.kind === "redirecting") return list;
  // The list itself is never missing; a 404 here is an unexpected response.
  if (list.kind === "notFound" || list.kind === "error") return { kind: "error", message: list.message };
  return { kind: "ready", data: { users: list.value.users, authMode: list.value.auth_mode } };
}

// A list loaded by a part of a screen (the move panels, the attachments panel and the links to a page), not by
// the screen itself.
export type ListResult<T> = { kind: "ok"; value: T } | { kind: "error" } | { kind: "redirecting" };

// The spaces the user can access, to choose the destination of a move from. Never rejects.
export async function loadSpaceList(client: ApiClient): Promise<ListResult<Space[]>> {
  const list = await request(() => client.api.v1.spaces.$get({ query: {} }));
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: list.value.spaces };
}

// All the users, to choose the members of a members space from. Admins only. Never rejects.
export async function loadUserList(client: ApiClient): Promise<ListResult<User[]>> {
  const list = await request(() => client.api.v1.users.$get());
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: list.value.users };
}

// The user IDs of the members of a members space, for the member editor. Admins only. A 404 (the space was
// deleted, or is not accessible) is notFound, so that the editor can say the space is gone. Never rejects.
export async function loadSpaceMembers(
  client: ApiClient,
  spaceId: string,
): Promise<{ kind: "ok"; value: string[] } | { kind: "notFound" } | { kind: "error" } | { kind: "redirecting" }> {
  if (!isValidId(spaceId)) return { kind: "notFound" };
  const members = await request(() => client.api.v1.spaces[":id"].members.$get({ param: { id: spaceId } }));
  if (members.kind === "redirecting") return members;
  if (members.kind === "notFound") return { kind: "notFound" };
  if (members.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: members.value.user_ids };
}

// All the folders of a space, to choose the destination of a move from. Never rejects.
export async function loadFolderList(client: ApiClient, spaceId: string): Promise<ListResult<Folder[]>> {
  if (!isValidId(spaceId)) return { kind: "error" };
  const list = await request(() => client.api.v1.spaces[":id"].folders.$get({ param: { id: spaceId } }));
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: list.value.folders };
}

// The pages of a space that are not in the trash, for the tree of the sidebar. Never rejects.
export async function loadPageList(client: ApiClient, spaceId: string): Promise<ListResult<PageSummary[]>> {
  if (!isValidId(spaceId)) return { kind: "error" };
  const list = await request(() => client.api.v1.spaces[":id"].pages.$get({ param: { id: spaceId } }));
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: list.value.pages };
}

// The attachments of a page, for the attachments panel of the edit screen. Never rejects.
export async function loadAttachmentList(client: ApiClient, pageId: string): Promise<ListResult<Attachment[]>> {
  if (!isValidId(pageId)) return { kind: "error" };
  const list = await request(() => client.api.v1.pages[":id"].attachments.$get({ param: { id: pageId } }));
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: list.value.attachments };
}

// The pages that link to a page, for the section at the end of the page screen. A 404 is an error, as the
// section is shown only after the page itself was loaded. Never rejects.
export async function loadBacklinks(
  client: ApiClient,
  pageId: string,
): Promise<ListResult<{ pages: PageSummary[]; hasMore: boolean }>> {
  if (!isValidId(pageId)) return { kind: "error" };
  const list = await request(() => client.api.v1.pages[":id"].backlinks.$get({ param: { id: pageId } }));
  if (list.kind === "redirecting") return list;
  if (list.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: { pages: list.value.pages, hasMore: list.value.has_more } };
}

// The page shown at the top of the home screen (null when none), for the button of the page screen that
// compares it with the page shown. Never rejects.
export async function loadTopPage(client: ApiClient): Promise<ListResult<Page | null>> {
  const top = await request(() => client.api.v1["top-page"].$get());
  if (top.kind === "redirecting") return top;
  if (top.kind !== "ok") return { kind: "error" };
  return { kind: "ok", value: top.value.page };
}

// Loads a screen's data while the component is mounted, and again when key changes or reload is called.
// A result that arrives after key has changed is dropped, so a previous screen does not overwrite the state.
export function useView<T>(load: () => Promise<Loaded<T>>, key: string): [ViewState<T>, () => void] {
  const [state, setState] = useState<ViewState<T>>({ kind: "loading" });
  // Incremented by reload to load again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // load is a new function on every render; key identifies what it loads.
  }, [key, attempt]);

  return [state, () => setAttempt((n) => n + 1)];
}
