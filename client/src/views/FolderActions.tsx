import { type FormEvent, type ReactNode, useState } from "react";
import type { Folder, Space } from "../../../src/api/types";
import { type FolderActionResult, createFolder, deleteFolder, moveFolder, updateFolder } from "../actions";
import { descendantIds } from "../folders";
import { widerVisibilityWarning } from "../format";
import { EditIcon, MoreIcon, MoveIcon, PlusIcon, TrashIcon } from "../icons";
import { Link } from "../Link";
import type { ApiClient } from "../load";
import { isValidId, navigate } from "../router";
import { useSidebarActions } from "../sidebarStore";
import { Menu } from "./common";
import { MoveFolderSelect, MoveSpaceSelect, useMoveDestination } from "./MoveDestination";
import { folderIdToValue, valueToFolderId } from "./PageEditor";

type Operation = "create" | "rename" | "move" | "delete";

type Failure =
  | { kind: "text"; text: string }
  // The folder of a rename, move or delete is gone.
  | { kind: "folderGone" };

const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";
const CREATE_NOT_FOUND_MESSAGE = "スペースかフォルダが見つかりません。読み込み直してください";

// The links and buttons below the heading of a space (folder null) or a folder: creating a page and a
// folder in it, and renaming, moving and deleting the folder. One operation is open at a time.
export function FolderActions({
  client,
  space,
  folders,
  folder,
  heading,
  onReload,
}: {
  client: ApiClient;
  // The space of the folder, which a move starts from.
  space: Space;
  // All the folders of the space.
  folders: Folder[];
  folder: Folder | null;
  // The title of the screen. When given, it is drawn here in a title row, with the menu for the folder next to it
  // (the folder screen); otherwise the caller draws the title (the space screen).
  heading?: ReactNode;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [name, setName] = useState("");
  // The destination space of a move, and the value of its folder select (see folderIdToValue).
  const [moveSpaceId, setMoveSpaceId] = useState(space.id);
  const [parentValue, setParentValue] = useState("");
  const sidebar = useSidebarActions();
  const destination = useMoveDestination(client, open === "move", moveSpaceId, (next) => {
    setMoveSpaceId(next);
    setParentValue(folderIdToValue(null));
  });

  const spaceId = space.id;
  if (!isValidId(spaceId)) return heading === undefined ? null : <div className="title-row">{heading}</div>;
  const folderId = folder !== null && isValidId(folder.id) ? folder.id : null;
  const newPagePath = folderId !== null ? `/spaces/${spaceId}/new?folder=${folderId}` : `/spaces/${spaceId}/new`;

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setName(operation === "rename" && folder ? folder.name : "");
    setMoveSpaceId(spaceId);
    setParentValue(folderIdToValue(folder?.parent_id ?? null));
  }

  function close() {
    setOpen(null);
    setFailure(null);
  }

  // Where to go after the folder is deleted: its parent, or the space.
  function pathAfterDelete(): string {
    const parentId = folder?.parent_id ?? null;
    return parentId !== null && isValidId(parentId) ? `/folders/${parentId}` : `/spaces/${spaceId}`;
  }

  async function run(operation: Operation, call: () => Promise<FolderActionResult>) {
    setSending(true);
    setFailure(null);
    // A move to another space changes the trees of both spaces.
    const changedSpaceIds = operation === "move" && moveSpaceId !== spaceId ? [spaceId, moveSpaceId] : [spaceId];
    const result = await call();
    // The operation may also have happened when the result is unknown.
    if (result.kind === "ok" || result.kind === "unknown") {
      for (const id of changedSpaceIds) sidebar.invalidateSpaceTree(id);
    }
    switch (result.kind) {
      case "ok":
        if (operation === "delete") {
          navigate(pathAfterDelete());
          return;
        }
        setSending(false);
        setOpen(null);
        onReload();
        return;
      case "notFound":
        setSending(false);
        setFailure(operation === "create" ? { kind: "text", text: CREATE_NOT_FOUND_MESSAGE } : { kind: "folderGone" });
        return;
      case "error":
        setSending(false);
        setFailure({ kind: "text", text: result.message });
        return;
      case "unknown":
        setSending(false);
        setFailure({ kind: "text", text: UNKNOWN_RESULT_MESSAGE });
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    switch (open) {
      case "create":
        void run("create", () => createFolder(client, spaceId, { name, parentId: folderId }));
        return;
      case "rename":
        if (folderId !== null) void run("rename", () => updateFolder(client, folderId, { name }));
        return;
      case "move":
        // Moves inside the space go through the same API as moves to another space.
        if (folderId !== null) {
          void run("move", () =>
            moveFolder(client, folderId, { spaceId: moveSpaceId, parentId: valueToFolderId(parentValue) }),
          );
        }
        return;
      case "delete":
        if (folderId !== null) void run("delete", () => deleteFolder(client, folderId));
        return;
      case null:
        return;
    }
  }

  // In its own space, the folder itself and the folders inside it cannot be its parent. Uses the folders
  // loaded for the move, which are newer than those of the screen.
  const moveFolders = destination.folders.kind === "ok" ? destination.folders.value : [];
  const moveExclude =
    folderId !== null && moveSpaceId === spaceId
      ? descendantIds(moveFolders, folderId).add(folderId)
      : new Set<string>();
  const moveDest = destination.space;
  const moveWarning = moveDest ? widerVisibilityWarning(space, moveDest) : null;
  const moveToOtherSpace = moveSpaceId !== spaceId;
  const moveUnchanged = !moveToOtherSpace && valueToFolderId(parentValue) === (folder?.parent_id ?? null);
  const moveBlocked =
    moveUnchanged || destination.spaces.kind !== "ok" || destination.folders.kind === "loading" || moveDest === null;

  return (
    <>
      {heading !== undefined && (
        <div className="title-row">
          {heading}
          {folderId !== null && (
            <Menu label="フォルダの操作" className="more-menu" summary={<MoreIcon />}>
              <button type="button" className="menu-item" onClick={() => openOperation("rename")} disabled={sending}>
                <EditIcon />
                名前を変更
              </button>
              <button type="button" className="menu-item" onClick={() => openOperation("move")} disabled={sending}>
                <MoveIcon />
                移動
              </button>
              <hr className="menu-separator" />
              <button
                type="button"
                className="menu-item menu-item-danger"
                onClick={() => openOperation("delete")}
                disabled={sending}
              >
                <TrashIcon />
                削除
              </button>
            </Menu>
          )}
        </div>
      )}
      <div className="actions">
        <Link to={newPagePath} className="button button-primary">
          <PlusIcon />
          ページを作成
        </Link>
        <button type="button" onClick={() => openOperation("create")} disabled={sending}>
          <PlusIcon />
          フォルダを作成
        </button>
      </div>
      {open !== null && (
        <form className="folder-form" aria-label={OPERATION_LABELS[open]} onSubmit={onSubmit}>
          {open === "create" && (
            <label>
              フォルダの名前
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={sending}
                autoFocus
              />
            </label>
          )}
          {open === "rename" && (
            <label>
              新しい名前
              {/* Opened from the menu to type the name: focused with the current name selected. */}
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                disabled={sending}
                autoFocus
              />
            </label>
          )}
          {open === "move" && (
            <>
              <MoveSpaceSelect destination={destination} disabled={sending} />
              <MoveFolderSelect
                destination={destination}
                value={parentValue}
                onChange={setParentValue}
                exclude={moveExclude}
                disabled={sending}
              />
              {(moveWarning !== null || moveToOtherSpace) && (
                <p>
                  {moveWarning}
                  中のページとフォルダ（ゴミ箱のページを含む）もすべて移ります。
                </p>
              )}
            </>
          )}
          {open === "delete" && <p>このフォルダを削除します。中にページやフォルダがあると削除できません。</p>}
          <div className="folder-form-actions">
            <button
              type="submit"
              className={open === "delete" ? "button-danger" : undefined}
              disabled={sending || (open === "move" && moveBlocked)}
            >
              {open === "move" && moveWarning !== null ? "公開範囲を広げて移動" : SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={close} disabled={sending}>
              やめる
            </button>
          </div>
          {failure?.kind === "text" && <p role="alert">{failure.text}</p>}
          {failure?.kind === "folderGone" && (
            <p role="alert">
              このフォルダは見つかりません。削除された可能性があります <Link to={`/spaces/${spaceId}`}>スペースへ</Link>
            </p>
          )}
        </form>
      )}
    </>
  );
}

const OPERATION_LABELS: Record<Operation, string> = {
  create: "フォルダを作成",
  rename: "名前を変更",
  move: "移動",
  delete: "削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  create: "作成",
  rename: "保存",
  move: "移動",
  delete: "削除",
};
