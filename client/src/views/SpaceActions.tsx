import { type FormEvent, useEffect, useState } from "react";
import type { Space } from "../../../src/api/types";
import {
  type SpaceActionResult,
  archiveSpace,
  deleteSpace,
  setSpaceMembers,
  unarchiveSpace,
  updateSpace,
} from "../actions";
import { ArchiveIcon, EditIcon, MoreIcon, SpaceKindIcon, TrashIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadSpaceMembers } from "../load";
import { navigate } from "../router";
import { useSidebarActions } from "../sidebarStore";
import { Menu } from "./common";
import { MemberPicker, selectedUserIds, useUserList } from "./MemberPicker";
import type { Loadable } from "./MoveDestination";

type Operation = "edit" | "members" | "archive" | "unarchive" | "delete";

type Failure =
  | { kind: "text"; text: string }
  // The space is gone.
  | { kind: "spaceGone" };

const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";
const SORT_ORDER_MIN = -1000000;
const SORT_ORDER_MAX = 1000000;
const INVALID_SORT_ORDER_MESSAGE = "表示順は -1000000 以上 1000000 以下の整数にしてください";

// Returns the integer in the input, or null if it is not an integer in the range the server accepts.
function parseSortOrder(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const sortOrder = Number(value);
  if (sortOrder < SORT_ORDER_MIN || sortOrder > SORT_ORDER_MAX) return null;
  return sortOrder;
}

// The menu for admins to edit (the name and the display order together), choose the members of a members space,
// archive (or unarchive) and delete a space other than a personal space. The caller shows it only to admins, for a
// space with a valid id. One operation is open at a time, independently of FolderActions. The caller puts it in the
// title row: the menu sits next to the title and the form below it.
export function SpaceActions({ client, space, onReload }: { client: ApiClient; space: Space; onReload: () => void }) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  // The members as loaded when the member editor was opened, then as checked.
  const [members, setMembers] = useState<Loadable<Set<string>>>({ kind: "loading" });
  const users = useUserList(client, open === "members");
  const sidebar = useSidebarActions();

  const spaceId = space.id;
  const archived = space.archived_at !== null;

  useEffect(() => {
    if (open !== "members") return;
    let cancelled = false;
    setMembers({ kind: "loading" });
    void loadSpaceMembers(client, spaceId).then((result) => {
      if (cancelled) return;
      switch (result.kind) {
        case "ok":
          setMembers({ kind: "ok", value: new Set(result.value) });
          return;
        case "notFound":
          setMembers({ kind: "error" });
          setFailure({ kind: "spaceGone" });
          return;
        case "error":
          setMembers({ kind: "error" });
          return;
        case "redirecting":
          // The move to the login page has started; the editor stays loading.
          return;
      }
    });
    return () => {
      cancelled = true;
    };
    // client does not change while the screen is shown.
  }, [open, spaceId]);

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setName(operation === "edit" ? (space.name ?? "") : "");
    setSortOrder(operation === "edit" ? String(space.sort_order) : "");
  }

  function close() {
    setOpen(null);
    setFailure(null);
  }

  async function run(operation: Operation, call: () => Promise<SpaceActionResult>) {
    setSending(true);
    setFailure(null);
    const result = await call();
    // The list of spaces drops the trees of the spaces that are gone. Either may have happened when the result is
    // unknown.
    if (result.kind === "ok" || result.kind === "unknown") sidebar.invalidateSpaces();
    switch (result.kind) {
      case "ok":
        if (operation === "delete") {
          navigate("/");
          return;
        }
        setSending(false);
        setOpen(null);
        onReload();
        return;
      case "notFound":
        setSending(false);
        setFailure({ kind: "spaceGone" });
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
      case "edit": {
        const value = parseSortOrder(sortOrder);
        if (value === null) {
          setFailure({ kind: "text", text: INVALID_SORT_ORDER_MESSAGE });
          return;
        }
        void run("edit", () => updateSpace(client, spaceId, { name, sortOrder: value }));
        return;
      }
      case "members": {
        // Saving is disabled until both are loaded.
        if (users.kind !== "ok" || members.kind !== "ok") return;
        const userIds = selectedUserIds(users.value, members.value);
        void run("members", () => setSpaceMembers(client, spaceId, userIds));
        return;
      }
      case "archive":
        void run("archive", () => archiveSpace(client, spaceId));
        return;
      case "unarchive":
        void run("unarchive", () => unarchiveSpace(client, spaceId));
        return;
      case "delete":
        void run("delete", () => deleteSpace(client, spaceId));
        return;
      case null:
        return;
    }
  }

  return (
    <>
      <Menu label="スペースの操作" className="more-menu" summary={<MoreIcon />}>
        <button type="button" className="menu-item" onClick={() => openOperation("edit")} disabled={sending}>
          <EditIcon />
          {OPERATION_LABELS.edit}
        </button>
        {space.kind === "members" && (
          <button type="button" className="menu-item" onClick={() => openOperation("members")} disabled={sending}>
            <SpaceKindIcon kind="members" />
            {OPERATION_LABELS.members}
          </button>
        )}
        <hr className="menu-separator" />
        {archived ? (
          <button type="button" className="menu-item" onClick={() => openOperation("unarchive")} disabled={sending}>
            <ArchiveIcon />
            {OPERATION_LABELS.unarchive}
          </button>
        ) : (
          <button type="button" className="menu-item" onClick={() => openOperation("archive")} disabled={sending}>
            <ArchiveIcon />
            {OPERATION_LABELS.archive}
          </button>
        )}
        <button
          type="button"
          className="menu-item menu-item-danger"
          onClick={() => openOperation("delete")}
          disabled={sending}
        >
          <TrashIcon />
          {OPERATION_LABELS.delete}
        </button>
      </Menu>
      {open !== null && (
        <form className="folder-form" aria-label={OPERATION_LABELS[open]} onSubmit={onSubmit}>
          {open === "edit" && (
            <>
              <label>
                名前
                {/* Opened from the menu, most often to type the name: focused with the current name selected. */}
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  disabled={sending}
                  autoFocus
                />
              </label>
              <label>
                表示順
                {/* No inputMode: iOS's numeric keyboard has no minus sign. */}
                <input
                  type="number"
                  className="sort-order-input"
                  step="1"
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  disabled={sending}
                />
              </label>
              {archived ? (
                <p className="form-hint">小さい数字ほどアーカイブ一覧の上に表示されます。同じ数字のスペースは作成順です。</p>
              ) : (
                <p className="form-hint">
                  小さい数字ほどサイドバーの上に表示されます。同じ数字のスペースは作成順です。新しいスペースは 0
                  で作られます。個人スペースは常に一番下です。
                </p>
              )}
            </>
          )}
          {open === "members" && (
            <>
              {members.kind === "loading" && <p className="form-hint">メンバーを読み込み中…</p>}
              {members.kind === "error" && failure?.kind !== "spaceGone" && (
                <p role="alert">メンバーを読み込めませんでした</p>
              )}
              {members.kind === "ok" && (
                <MemberPicker
                  users={users}
                  selected={members.value}
                  onChange={(selected) => setMembers({ kind: "ok", value: selected })}
                  disabled={sending}
                />
              )}
            </>
          )}
          {open === "archive" && (
            <p>
              このスペースをアーカイブします。中のページやフォルダは閲覧だけになり、サイドバーやホームには表示されなくなります。サイドバーの『アーカイブ』からいつでも開けて、解除もできます。
            </p>
          )}
          {open === "unarchive" && <p>アーカイブを解除して、通常のスペースに戻します。</p>}
          {open === "delete" && (
            <p>このスペースを削除します。ページ（ゴミ箱のページを含む）やフォルダが残っていると削除できません。</p>
          )}
          <div className="folder-form-actions">
            <button
              type="submit"
              className={open === "delete" ? "button-danger" : undefined}
              disabled={sending || (open === "members" && (users.kind !== "ok" || members.kind !== "ok"))}
            >
              {SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={close} disabled={sending}>
              やめる
            </button>
          </div>
          {failure?.kind === "text" && <p role="alert">{failure.text}</p>}
          {failure?.kind === "spaceGone" && (
            <p role="alert">
              このスペースは見つかりません。削除された可能性があります <Link to="/">ホームへ</Link>
            </p>
          )}
        </form>
      )}
    </>
  );
}

const OPERATION_LABELS: Record<Operation, string> = {
  edit: "スペースを編集",
  members: "メンバーを編集",
  archive: "スペースをアーカイブ",
  unarchive: "アーカイブを解除",
  delete: "スペースを削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  edit: "保存",
  members: "保存",
  archive: "アーカイブ",
  unarchive: "解除",
  delete: "削除",
};
