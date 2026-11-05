import { type FormEvent, useState } from "react";
import type { Space } from "../../../src/api/types";
import { type SpaceActionResult, deleteSpace, renameSpace, updateSpaceSortOrder } from "../actions";
import { EditIcon, MoreIcon, TrashIcon } from "../icons";
import { Link } from "../Link";
import type { ApiClient } from "../load";
import { navigate } from "../router";
import { useSidebarActions } from "../sidebarStore";
import { Menu } from "./common";

type Operation = "rename" | "sortOrder" | "delete";

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

// The buttons for admins to rename, reorder and delete a space other than a personal space. The caller shows them
// only to admins, for a space with a valid id. One operation is open at a time, independently of
// FolderActions. The caller puts it in the title row: the menu sits next to the title and the form below it.
export function SpaceActions({ client, space, onReload }: { client: ApiClient; space: Space; onReload: () => void }) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  const sidebar = useSidebarActions();

  const spaceId = space.id;

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setName(operation === "rename" ? (space.name ?? "") : "");
    setSortOrder(operation === "sortOrder" ? String(space.sort_order) : "");
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
      case "rename":
        void run("rename", () => renameSpace(client, spaceId, name));
        return;
      case "sortOrder": {
        const value = parseSortOrder(sortOrder);
        if (value === null) {
          setFailure({ kind: "text", text: INVALID_SORT_ORDER_MESSAGE });
          return;
        }
        void run("sortOrder", () => updateSpaceSortOrder(client, spaceId, value));
        return;
      }
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
        <button type="button" className="menu-item" onClick={() => openOperation("rename")} disabled={sending}>
          <EditIcon />
          {OPERATION_LABELS.rename}
        </button>
        <button type="button" className="menu-item" onClick={() => openOperation("sortOrder")} disabled={sending}>
          <EditIcon />
          {OPERATION_LABELS.sortOrder}
        </button>
        <hr className="menu-separator" />
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
          {open === "sortOrder" && (
            <>
              <label>
                表示順
                {/* No inputMode: iOS's numeric keyboard has no minus sign. */}
                <input
                  type="number"
                  step="1"
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  disabled={sending}
                  autoFocus
                />
              </label>
              <p>
                小さい数字ほどサイドバーの上に表示されます。同じ数字のスペースは作成順です。新しいスペースは 0
                で作られます。個人スペースは常に一番下です。
              </p>
            </>
          )}
          {open === "delete" && (
            <p>このスペースを削除します。ページ（ゴミ箱のページを含む）やフォルダが残っていると削除できません。</p>
          )}
          <div className="folder-form-actions">
            <button type="submit" className={open === "delete" ? "button-danger" : undefined} disabled={sending}>
              {SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={close} disabled={sending}>
              やめる
            </button>
          </div>
          {failure?.kind === "text" && <p role="alert">{failure.text}</p>}
          {failure?.kind === "spaceGone" && (
            <p role="alert">
              このスペースは見つかりません。削除された可能性があります <Link to="/">スペース一覧へ</Link>
            </p>
          )}
        </form>
      )}
    </>
  );
}

const OPERATION_LABELS: Record<Operation, string> = {
  rename: "スペースの名前を変更",
  sortOrder: "表示順を変更",
  delete: "スペースを削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  rename: "保存",
  sortOrder: "保存",
  delete: "削除",
};
