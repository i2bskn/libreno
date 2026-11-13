import type { Attachment, CreateSpaceRequest, CreateUserRequest, Page, Space, User } from "../../src/api/types";
// A value import from the server code: validation.ts imports nothing else, so no other server code is bundled.
import { ATTACHMENT_MAX_BYTES, emptyFileMessage, fileTooLargeMessage } from "../../src/attachments/validation";
import { LoginRequiredError, responseError, responseErrorMessage, unexpectedResponseMessage } from "./api";
import type { PageChanges } from "./edit";
import type { ApiClient } from "./load";
import { isValidId } from "./router";

// The outcomes shared by the actions below.
type SendFailure =
  | { kind: "error"; message: string }
  // The request did not get a response, so it may have succeeded on the server.
  | { kind: "unknown" }
  // Login is required and the move to the login page has started.
  | { kind: "redirecting" };

// Sorts a 409 of a write to a page: space_archived (the space was archived) is an error with the server's
// message, any other code is a conflict (someone else changed the page first).
async function conflictOrArchived(res: {
  status: number;
  json(): Promise<unknown>;
}): Promise<{ kind: "conflict" } | { kind: "error"; message: string }> {
  const { code, message } = await responseError(res);
  if (code === "space_archived") return { kind: "error", message };
  return { kind: "conflict" };
}

// Sends a request. A rejection becomes the failure to return; never rejects.
async function send<R>(call: () => Promise<R>): Promise<{ kind: "response"; res: R } | SendFailure> {
  try {
    return { kind: "response", res: await call() };
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "unknown" };
  }
}

export type RestoreRevisionResult =
  | { kind: "ok" }
  // Someone else updated the page after it was loaded.
  | { kind: "conflict" }
  | { kind: "error"; message: string }
  // The request did not get a response, so it may have succeeded on the server.
  | { kind: "unknown" }
  // Login is required and the move to the login page has started.
  | { kind: "redirecting" };

// Restores a revision of a page. currentVersion is the version of the page as loaded. Never rejects.
export async function restoreRevision(
  client: ApiClient,
  pageId: string,
  revisionVersion: number,
  currentVersion: number,
): Promise<RestoreRevisionResult> {
  let res;
  try {
    res = await client.api.v1.pages[":id"].revisions[":version"].restore.$post({
      param: { id: pageId, version: String(revisionVersion) },
      json: { version: currentVersion },
    });
  } catch (error) {
    if (error instanceof LoginRequiredError) return { kind: "redirecting" };
    return { kind: "unknown" };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 409) return conflictOrArchived(res);
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type TrashPageResult =
  | { kind: "ok" }
  // The page is missing, already in the trash, or not accessible.
  | { kind: "notFound" }
  | SendFailure;

// Moves a page to the trash of its space. Never rejects.
export async function trashPage(client: ApiClient, pageId: string): Promise<TrashPageResult> {
  const sent = await send(() => client.api.v1.pages[":id"].$delete({ param: { id: pageId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type RestoreTrashedPageResult =
  | { kind: "ok"; page: Page }
  | { kind: "notFound" }
  // The page is not in the trash: someone else restored it first.
  | { kind: "conflict" }
  | SendFailure;

// Takes a page out of the trash. Never rejects.
export async function restoreTrashedPage(client: ApiClient, pageId: string): Promise<RestoreTrashedPageResult> {
  const sent = await send(() => client.api.v1.pages[":id"].restore.$post({ param: { id: pageId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", page: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  if (res.status === 404) return { kind: "notFound" };
  if (res.status === 409) return conflictOrArchived(res);
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type PurgeTrashedPageResult =
  | { kind: "ok" }
  | { kind: "notFound" }
  // The page is not in the trash: someone else restored it first.
  | { kind: "conflict" }
  // Not an admin, or a page of a personal space. message is the server's.
  | { kind: "forbidden"; message: string }
  | SendFailure;

// Deletes a page in the trash with its revisions. Never rejects.
export async function purgeTrashedPage(client: ApiClient, pageId: string): Promise<PurgeTrashedPageResult> {
  const sent = await send(() => client.api.v1.pages[":id"].permanent.$delete({ param: { id: pageId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  if (res.status === 409) return conflictOrArchived(res);
  if (res.status === 403) return { kind: "forbidden", message: await responseErrorMessage(res) };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type CreatePageResult =
  | { kind: "ok"; page: Page }
  // The space is missing or not accessible.
  | { kind: "notFound" }
  | SendFailure;

// Creates a page. The server trims the title. folderId null creates it at the top level. Never rejects.
export async function createPage(
  client: ApiClient,
  spaceId: string,
  input: { title: string; body: string; folderId: string | null },
): Promise<CreatePageResult> {
  const sent = await send(() =>
    client.api.v1.spaces[":id"].pages.$post({
      param: { id: spaceId },
      json: { title: input.title, body: input.body, folder_id: input.folderId },
    }),
  );
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", page: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type UpdatePageResult =
  | { kind: "ok"; page: Page }
  // The page is missing, in the trash, or not accessible.
  | { kind: "notFound" }
  // Someone else updated the page after it was loaded.
  | { kind: "conflict" }
  | SendFailure;

// Updates a page. version is the version of the page as loaded; changes has at least one field.
// Never rejects.
export async function updatePage(
  client: ApiClient,
  pageId: string,
  version: number,
  changes: PageChanges,
): Promise<UpdatePageResult> {
  const sent = await send(() =>
    client.api.v1.pages[":id"].$patch({ param: { id: pageId }, json: { version, ...changes } }),
  );
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", page: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  if (res.status === 404) return { kind: "notFound" };
  if (res.status === 409) return conflictOrArchived(res);
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type MovePageResult =
  | { kind: "ok"; page: Page }
  // The page is missing, in the trash, or not accessible.
  | { kind: "notFound" }
  // Someone else updated the page after it was loaded.
  | { kind: "conflict" }
  | SendFailure;

// Moves a page to a folder (or the top level, for null) of a space, which may be its own space.
// version is the version of the page as loaded. Never rejects.
export async function movePage(
  client: ApiClient,
  pageId: string,
  input: { version: number; spaceId: string; folderId: string | null },
): Promise<MovePageResult> {
  const sent = await send(() =>
    client.api.v1.pages[":id"].move.$post({
      param: { id: pageId },
      json: { version: input.version, space_id: input.spaceId, folder_id: input.folderId },
    }),
  );
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", page: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  if (res.status === 404) return { kind: "notFound" };
  if (res.status === 409) return conflictOrArchived(res);
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the folder and space actions. Errors of the request (400), of the permissions (403) and of
// the state of the resources (409: a cycle, a name in use, a folder or space that is not empty) are shown
// with the server's message.
type ResourceActionResult =
  | { kind: "ok" }
  // The resource (a folder or a space), or the space or parent a folder is created in, is missing or not
  // accessible.
  | { kind: "notFound" }
  | SendFailure;

export type FolderActionResult = ResourceActionResult;
export type SpaceActionResult = ResourceActionResult;

async function resourceActionResult<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  sent: { kind: "response"; res: R } | SendFailure,
): Promise<ResourceActionResult> {
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Creates a folder in parentId, or at the top level of the space for null. Never rejects.
export async function createFolder(
  client: ApiClient,
  spaceId: string,
  input: { name: string; parentId: string | null },
): Promise<FolderActionResult> {
  return resourceActionResult(
    await send(() =>
      client.api.v1.spaces[":id"].folders.$post({
        param: { id: spaceId },
        json: { name: input.name, parent_id: input.parentId },
      }),
    ),
  );
}

// Renames a folder or moves it (parent_id null moves it to the top level). Never rejects.
export async function updateFolder(
  client: ApiClient,
  folderId: string,
  changes: { name?: string; parent_id?: string | null },
): Promise<FolderActionResult> {
  return resourceActionResult(
    await send(() => client.api.v1.folders[":id"].$patch({ param: { id: folderId }, json: changes })),
  );
}

// Moves a folder with its contents into a folder (or the top level, for null) of a space, which may be its
// own space. Never rejects.
export async function moveFolder(
  client: ApiClient,
  folderId: string,
  input: { spaceId: string; parentId: string | null },
): Promise<FolderActionResult> {
  return resourceActionResult(
    await send(() =>
      client.api.v1.folders[":id"].move.$post({
        param: { id: folderId },
        json: { space_id: input.spaceId, parent_id: input.parentId },
      }),
    ),
  );
}

// Deletes an empty folder. Never rejects.
export async function deleteFolder(client: ApiClient, folderId: string): Promise<FolderActionResult> {
  return resourceActionResult(await send(() => client.api.v1.folders[":id"].$delete({ param: { id: folderId } })));
}

export type CreateSpaceResult = { kind: "ok"; space: Space } | SendFailure;

// Creates a space that everyone, only admins, or the chosen members and admins can see. Admins only; the server
// trims the name. memberIds is sent only for a members space (the server rejects it for the other kinds). Errors,
// including a non-admin (403) and a member deleted meanwhile, are shown with the server's message. Never rejects.
export async function createSpace(
  client: ApiClient,
  input: { kind: CreateSpaceRequest["kind"]; name: string; memberIds?: string[] },
): Promise<CreateSpaceResult> {
  const json: CreateSpaceRequest = { kind: input.kind, name: input.name };
  if (input.kind === "members") json.member_ids = input.memberIds ?? [];
  const sent = await send(() => client.api.v1.spaces.$post({ json }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", space: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// Changes the name and the display order of a space other than a personal space in one request; the server
// leaves a field that did not change as it is. Admins only. Never rejects.
export async function updateSpace(
  client: ApiClient,
  spaceId: string,
  fields: { name: string; sortOrder: number },
): Promise<SpaceActionResult> {
  return resourceActionResult(
    await send(() =>
      client.api.v1.spaces[":id"].$patch({
        param: { id: spaceId },
        json: { name: fields.name, sort_order: fields.sortOrder },
      }),
    ),
  );
}

// Replaces the members of a members space. Admins only. Never rejects.
export async function setSpaceMembers(client: ApiClient, spaceId: string, userIds: string[]): Promise<SpaceActionResult> {
  return resourceActionResult(
    await send(() =>
      client.api.v1.spaces[":id"].members.$put({ param: { id: spaceId }, json: { user_ids: userIds } }),
    ),
  );
}

// Archives a space other than a personal space: its contents become read only and it is listed only on the
// archive screen. Admins only. Never rejects.
export async function archiveSpace(client: ApiClient, spaceId: string): Promise<SpaceActionResult> {
  return resourceActionResult(await send(() => client.api.v1.spaces[":id"].archive.$post({ param: { id: spaceId } })));
}

// Unarchives a space. Admins only. Never rejects.
export async function unarchiveSpace(client: ApiClient, spaceId: string): Promise<SpaceActionResult> {
  return resourceActionResult(
    await send(() => client.api.v1.spaces[":id"].unarchive.$post({ param: { id: spaceId } })),
  );
}

// Deletes an empty space other than a personal space. Admins only. Never rejects.
export async function deleteSpace(client: ApiClient, spaceId: string): Promise<SpaceActionResult> {
  return resourceActionResult(await send(() => client.api.v1.spaces[":id"].$delete({ param: { id: spaceId } })));
}

export type SetTopPageResult = { kind: "ok"; page: Page | null } | SendFailure;

// Shows a page at the top of the home screen, or clears the setting with null. Admins only. Errors,
// including a page outside an everyone space and a missing page, are shown with the server's message.
// Never rejects.
export async function setTopPage(client: ApiClient, pageId: string | null): Promise<SetTopPageResult> {
  if (pageId !== null && !isValidId(pageId)) return { kind: "error", message: "ページが見つかりません" };
  const sent = await send(() => client.api.v1["top-page"].$put({ json: { page_id: pageId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", page: (await res.json()).page };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type UploadAttachmentResult =
  | { kind: "ok"; attachment: Attachment }
  // The page is missing, in the trash, or not accessible.
  | { kind: "notFound" }
  | SendFailure;

// Attaches a file to a page. The body is the file itself; the server decides the type from the contents.
// Empty files and files over 10MB are rejected here with the server's messages, without sending.
// The File is sent as is (not as a stream), so that the retry after refreshing the login can send it again.
// Never rejects.
export async function uploadAttachment(client: ApiClient, pageId: string, file: File): Promise<UploadAttachmentResult> {
  if (file.size === 0) return { kind: "error", message: emptyFileMessage };
  if (file.size > ATTACHMENT_MAX_BYTES) return { kind: "error", message: fileTooLargeMessage };
  const sent = await send(() =>
    client.api.v1.pages[":id"].attachments.$post(
      { param: { id: pageId }, query: { filename: file.name } },
      { init: { body: file } },
    ),
  );
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", attachment: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type DeleteAttachmentResult =
  | { kind: "ok" }
  // The attachment is missing (e.g. already deleted), or its page is in the trash or not accessible.
  | { kind: "notFound" }
  | SendFailure;

// Deletes an attachment. This cannot be undone. Never rejects.
export async function deleteAttachment(client: ApiClient, attachmentId: string): Promise<DeleteAttachmentResult> {
  const sent = await send(() => client.api.v1.attachments[":id"].$delete({ param: { id: attachmentId } }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) return { kind: "notFound" };
  return { kind: "error", message: await responseErrorMessage(res) };
}

export type CreateUserResult = { kind: "ok"; user: User } | SendFailure;

// Creates a user with a password (password mode only). Admins only. Errors, including email_taken (409) and
// the 404 of OIDC mode, are shown with the server's message. Never rejects.
export async function createUser(client: ApiClient, input: CreateUserRequest): Promise<CreateUserResult> {
  const sent = await send(() => client.api.v1.users.$post({ json: input }));
  if (sent.kind !== "response") return sent;
  const { res } = sent;
  if (res.ok) {
    try {
      return { kind: "ok", user: await res.json() };
    } catch {
      return { kind: "error", message: unexpectedResponseMessage(res.status) };
    }
  }
  return { kind: "error", message: await responseErrorMessage(res) };
}

// The outcome of the actions on a user. notFound means the user is gone; other errors (400, 403, and 409
// last_admin) are shown with the server's message.
export type UserActionResult = ResourceActionResult;

// hc() puts params into the URL without encoding them, so an invalid ID is not sent.
const INVALID_USER_ID: UserActionResult = { kind: "error", message: "ユーザーが見つかりません" };

// Changes the role of a user. Admins only. Never rejects.
export async function changeUserRole(client: ApiClient, userId: string, role: User["role"]): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].$patch({ param: { id: userId }, json: { role } })),
  );
}

// Sets a new password for a user and ends their sessions and MCP connections (password mode only). Admins
// only. In OIDC mode the server also answers 404 with the same code, which cannot be told apart from a
// missing user; it only happens if the mode changed after the screen loaded, and the reload that follows
// hides the button. Never rejects.
export async function resetUserPassword(client: ApiClient, userId: string, password: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"].password.$post({ param: { id: userId }, json: { password } })),
  );
}

// Ends the sessions and MCP connections of a user. Admins only. Never rejects.
export async function revokeUserSessions(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(
    await send(() => client.api.v1.users[":id"]["revoke-sessions"].$post({ param: { id: userId } })),
  );
}

// Deletes a user with their personal space and everything in it. This cannot be undone. Admins only.
// Never rejects.
export async function deleteUser(client: ApiClient, userId: string): Promise<UserActionResult> {
  if (!isValidId(userId)) return INVALID_USER_ID;
  return resourceActionResult(await send(() => client.api.v1.users[":id"].$delete({ param: { id: userId } })));
}
