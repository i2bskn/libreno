import type { Role } from "../auth/validate";
import type { AuthMode } from "../env";

export type User = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  last_login_at: number | null;
};

export type UserList = {
  users: User[];
  // The screen hides the operations that exist only in password mode.
  auth_mode: AuthMode;
};

export type ApiError = {
  error: {
    // snake_case error code, e.g. `invalid_email`, `not_found`.
    code: string;
    message: string;
  };
};

export type ChangeMyPasswordRequest = {
  current_password: string;
  new_password: string;
};

export type CreateUserRequest = {
  email: string;
  name?: string | null;
  password: string;
  role: Role;
};

// CreateUserRequest after validation. email is normalized and a missing or blank name is null.
export type CreateUserInput = {
  email: string;
  name: string | null;
  password: string;
  role: Role;
};

export type ResetPasswordRequest = {
  password: string;
};

export type UpdateUserRequest = {
  role: Role;
};

export type SpaceKind = "everyone" | "admin" | "personal";

export type Space = {
  id: string;
  kind: SpaceKind;
  // null for personal spaces; clients decide the display name.
  name: string | null;
  // Display order: smaller comes first. Personal spaces always come last.
  sort_order: number;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  updated_at: number;
};

export type SpaceList = {
  spaces: Space[];
};

// Personal spaces are created with their user and cannot be created here.
export type CreateSpaceRequest = {
  kind: "everyone" | "admin";
  name: string;
};

// CreateSpaceRequest after validation. name is trimmed.
export type CreateSpaceInput = {
  kind: "everyone" | "admin";
  name: string;
};

export type UpdateSpaceRequest = {
  name?: string;
  sort_order?: number;
};

// UpdateSpaceRequest after validation. name is trimmed.
export type UpdateSpaceInput = {
  name?: string;
  sortOrder?: number;
};

// Folders organize pages inside one space and carry no permissions of their own.
export type Folder = {
  id: string;
  space_id: string;
  // null for a folder at the top level of the space.
  parent_id: string | null;
  name: string;
  // null once the user is deleted.
  created_by: string | null;
  // null once the user is deleted.
  updated_by: string | null;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  updated_at: number;
};

// All folders of a space as a flat list, ordered by name and id. Build the tree with parent_id.
export type FolderList = {
  folders: Folder[];
};

// A missing or null parent_id creates the folder at the top level of the space.
export type CreateFolderRequest = {
  name: string;
  parent_id?: string | null;
};

// CreateFolderRequest after validation. name is trimmed and a missing parent_id is null.
export type CreateFolderInput = {
  name: string;
  parentId: string | null;
};

// At least one of name and parent_id is required; this is checked at runtime, not by the type.
// parent_id null moves the folder to the top level; the folder stays in its space (see MoveFolderRequest).
export type UpdateFolderRequest = {
  name?: string;
  parent_id?: string | null;
};

// UpdateFolderRequest after validation. name is trimmed; undefined keeps the current value.
export type UpdateFolderInput = {
  name?: string;
  parentId?: string | null;
};

// Moves the folder with the folders and pages in it (including pages in the trash) to another space, or
// inside its space. A missing or null parent_id moves it to the top level of the destination space.
export type MoveFolderRequest = {
  // The destination space. The user needs access to both spaces.
  space_id: string;
  // A folder in the destination space.
  parent_id?: string | null;
};

// MoveFolderRequest after validation. A missing parent_id is null.
export type MoveFolderInput = {
  spaceId: string;
  parentId: string | null;
};

// A page without its body, as returned by page lists.
export type PageSummary = {
  id: string;
  space_id: string;
  // null for a page at the top level of the space.
  folder_id: string | null;
  title: string;
  // Starts at 1 and is incremented on every update. Send it back when updating.
  version: number;
  // null once the user is deleted.
  created_by: string | null;
  // null once the user is deleted.
  updated_by: string | null;
  // UNIX time in milliseconds.
  created_at: number;
  // UNIX time in milliseconds.
  updated_at: number;
};

// PageSummary with the body. Written out flat rather than as an intersection so that it is
// the same type as the response inferred by hc<AppType>().
export type Page = {
  id: string;
  space_id: string;
  folder_id: string | null;
  title: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  // Markdown.
  body: string;
};

export type PageList = {
  pages: PageSummary[];
};

export type CreatePageRequest = {
  title: string;
  body: string;
  // A folder in the same space. Missing or null puts the page at the top level of the space.
  folder_id?: string | null;
};

// CreatePageRequest after validation. title is trimmed and a missing folder_id is null.
export type CreatePageInput = {
  title: string;
  body: string;
  folderId: string | null;
};

// At least one of title, body and folder_id is required; this is checked at runtime, not by the type.
export type UpdatePageRequest = {
  // The version the change is based on. A different current version is a conflict.
  version: number;
  title?: string;
  body?: string;
  // Moves the page to a folder in the same space; null moves it to the top level.
  // To move it to another space, see MovePageRequest.
  folder_id?: string | null;
};

// UpdatePageRequest after validation. title is trimmed; undefined keeps the current value.
export type UpdatePageInput = {
  version: number;
  title?: string;
  body?: string;
  folderId?: string | null;
};

// Moves the page to another space, or inside its space. A missing or null folder_id moves it to the top
// level of the destination space. The revisions move with the page.
export type MovePageRequest = {
  // The version the move is based on. A different current version is a conflict.
  version: number;
  // The destination space. The user needs access to both spaces.
  space_id: string;
  // A folder in the destination space.
  folder_id?: string | null;
};

// MovePageRequest after validation. A missing folder_id is null.
export type MovePageInput = {
  version: number;
  spaceId: string;
  folderId: string | null;
};

// An earlier version of a page, without its body.
export type PageRevisionSummary = {
  // pages.version when this was the content.
  version: number;
  title: string;
  // The user who saved this version. null once the user is deleted.
  created_by: string | null;
  // UNIX time in milliseconds when this version was saved.
  created_at: number;
};

// PageRevisionSummary with the page id and the body. Written out flat like Page.
export type PageRevision = {
  page_id: string;
  version: number;
  title: string;
  created_by: string | null;
  created_at: number;
  // Markdown.
  body: string;
};

export type PageRevisionList = {
  // Newest first. Only the newest 20 earlier versions are kept; the current content is the page itself.
  revisions: PageRevisionSummary[];
};

export type RestorePageRevisionRequest = {
  // The current version of the page. A different current version is a conflict.
  version: number;
};

// A page found by search, without its body. Written out flat like Page.
export type SearchHit = {
  id: string;
  space_id: string;
  folder_id: string | null;
  title: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  // The body around the first match: 40 characters before, the match, and 40 after.
  // null when only the title matches.
  snippet: string | null;
};

export type SearchResult = {
  hits: SearchHit[];
  // true when more than 50 pages matched; only the first 50 are returned.
  has_more: boolean;
};

// A page in the trash of its space, without its body. Written out flat like Page.
export type TrashedPage = {
  id: string;
  space_id: string;
  // The folder the page goes back to when restored. null for the top level, also after the folder is deleted.
  folder_id: string | null;
  title: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  // UNIX time in milliseconds when the page was moved to the trash.
  deleted_at: number;
  // The user who moved the page to the trash. May refer to a deleted user.
  deleted_by: string | null;
  // UNIX time in milliseconds after which the scheduled job deletes the page (deleted_at + 30 days).
  purge_after: number;
};

export type TrashList = {
  // Most recently deleted first.
  pages: TrashedPage[];
};

// A file attached to a page. It can be read by everyone who can read the page, and not while the page is
// in the trash.
export type Attachment = {
  id: string;
  page_id: string;
  // Normalized by the server, with the extension of content_type.
  filename: string;
  // Decided by the server from the contents.
  content_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf";
  // Bytes.
  size: number;
  // null once the user is deleted.
  created_by: string | null;
  // UNIX time in milliseconds.
  created_at: number;
  // Where the contents are served: "/api/v1/attachments/{id}".
  url: string;
  // Markdown to put in the page body: "![name](url)" for images, "[name](url)" for PDF.
  markdown: string;
};

export type AttachmentList = {
  // Oldest first.
  attachments: Attachment[];
};

// The pages whose body contains "/pages/{id}" of the page, in spaces the viewer can access and not in the trash.
export type BacklinkList = {
  // Most recently updated first.
  pages: PageSummary[];
  // true when more than 50 pages link to the page; only the first 50 are returned.
  has_more: boolean;
};


// The page shown at the top of the home screen, the same for every signed-in user. null when none is set, or
// while the chosen page is not in an everyone space or is in the trash.
export type TopPage = {
  page: Page | null;
};

// Admins only. The page must be in an everyone space and not in the trash; null clears the setting.
export type SetTopPageRequest = {
  page_id: string | null;
};
