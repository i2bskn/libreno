import { useState } from "react";
import type { TrashedPage } from "../../../src/api/types";
import { purgeTrashedPage, restoreTrashedPage } from "../actions";
import { formatDateTime, formatPurgeRemaining, spaceDisplayName } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadTrashView, useView } from "../load";
import { isValidId } from "../router";
import { useSidebarActions, useSidebarLocation, viewLocation } from "../sidebarStore";
import { ArchivedNotice, BreadcrumbRoot, ViewStatus, isArchived, useDocumentTitle, viewTitle } from "./common";

// The result of the last action, shown above the list until the next one.
type Notice = { kind: "text"; text: string } | { kind: "restored"; id: string; title: string };

const GONE_MESSAGE = "すでに元に戻されたか、削除されています";
const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。一覧を読み込み直して確かめてください";

// isAdmin only decides whether the purge buttons are shown; the server checks it again.
export function TrashView({ client, id, isAdmin }: { client: ApiClient; id: string; isAdmin: boolean }) {
  const [state, reload] = useView(() => loadTrashView(client, id), id);
  const [notice, setNotice] = useState<Notice | null>(null);
  // An action is being sent. The buttons of every row are disabled until it ends.
  const [sending, setSending] = useState(false);
  useDocumentTitle(viewTitle(state, (data) => `ゴミ箱 - ${spaceDisplayName(data.space)}`));
  useSidebarLocation(
    viewLocation(state, (data) => ({ spaceId: data.space.id, folderId: null, pageId: null, current: "location" })),
  );
  const sidebar = useSidebarActions();

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="スペースが見つかりません" onReload={reload} />;
  }
  const { space, pages } = state.data;
  const name = spaceDisplayName(space);
  // The pages in the trash of an archived space can be neither restored nor deleted.
  const archived = isArchived(space);
  // Pages of personal spaces are left to the scheduled deletion, even for admins.
  const canPurge = isAdmin && space.kind !== "personal" && !archived;
  const now = Date.now();

  async function onRestore(page: TrashedPage) {
    setSending(true);
    setNotice(null);
    const result = await restoreTrashedPage(client, page.id);
    // The page may be back in the tree, also when someone else restored it first (not found, conflict) and when
    // the result is unknown.
    if (result.kind !== "error" && result.kind !== "redirecting") sidebar.invalidateSpaceTree(space.id);
    switch (result.kind) {
      case "ok":
        setNotice({ kind: "restored", id: result.page.id, title: result.page.title });
        setSending(false);
        reload();
        return;
      case "notFound":
      case "conflict":
        setNotice({ kind: "text", text: GONE_MESSAGE });
        setSending(false);
        reload();
        return;
      case "error":
        setNotice({ kind: "text", text: result.message });
        setSending(false);
        return;
      case "unknown":
        setNotice({ kind: "text", text: UNKNOWN_RESULT_MESSAGE });
        setSending(false);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  // Returns whether the row should close its confirmation.
  async function onPurge(page: TrashedPage): Promise<boolean> {
    setSending(true);
    setNotice(null);
    const result = await purgeTrashedPage(client, page.id);
    switch (result.kind) {
      case "ok":
        setSending(false);
        reload();
        return true;
      case "notFound":
      case "conflict":
        setNotice({ kind: "text", text: GONE_MESSAGE });
        setSending(false);
        reload();
        return true;
      case "forbidden":
      case "error":
        setNotice({ kind: "text", text: result.message });
        setSending(false);
        return false;
      case "unknown":
        setNotice({ kind: "text", text: UNKNOWN_RESULT_MESSAGE });
        setSending(false);
        return false;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return false;
    }
  }

  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <BreadcrumbRoot archived={archived} />
          <li>{isValidId(space.id) ? <Link to={`/spaces/${space.id}`}>{name}</Link> : name}</li>
          <li aria-current="page">ゴミ箱</li>
        </ol>
      </nav>
      <h1>ゴミ箱</h1>
      <p className="title-note">削除したページは&nbsp;30&nbsp;日たつと完全に削除されます。</p>
      {archived && <ArchivedNotice />}
      {notice && (
        <p className="notice" role="status">
          {notice.kind === "text" ? (
            notice.text
          ) : (
            <>
              「{notice.title}」を元に戻しました
              {isValidId(notice.id) && (
                <>
                  {" "}
                  <Link to={`/pages/${notice.id}`}>ページを開く</Link>
                </>
              )}
            </>
          )}
        </p>
      )}
      {pages.length === 0 ? (
        <p className="empty">ゴミ箱は空です</p>
      ) : (
        <ul className="trash">
          {pages.map((page) => (
            <TrashRow
              key={page.id}
              page={page}
              now={now}
              canRestore={!archived}
              canPurge={canPurge}
              sending={sending}
              onRestore={() => void onRestore(page)}
              onPurge={() => onPurge(page)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function TrashRow({
  page,
  now,
  canRestore,
  canPurge,
  sending,
  onRestore,
  onPurge,
}: {
  page: TrashedPage;
  now: number;
  canRestore: boolean;
  canPurge: boolean;
  sending: boolean;
  onRestore: () => void;
  onPurge: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);

  async function onConfirmPurge() {
    if (await onPurge()) setConfirming(false);
  }

  return (
    <li>
      <div className="trash-row">
        {/* Not a link: pages in the trash cannot be opened. */}
        <span className="trash-title">{page.title}</span>
        <span className="trash-detail">
          <time dateTime={new Date(page.deleted_at).toISOString()}>削除: {formatDateTime(page.deleted_at)}</time>
          <span>{formatPurgeRemaining(page.purge_after, now)}</span>
        </span>
        <span className="trash-actions">
          {canRestore && (
            <button type="button" onClick={onRestore} disabled={sending}>
              元に戻す
            </button>
          )}
          {canPurge && !confirming && (
            <button
              type="button"
              className="button-danger-outline"
              onClick={() => setConfirming(true)}
              disabled={sending}
            >
              完全に削除
            </button>
          )}
        </span>
      </div>
      {canPurge && confirming && (
        <div className="trash-confirm" role="group" aria-label="完全に削除">
          {/* Each sentence wraps as a whole on narrow screens. */}
          <p>
            <span className="sentence">履歴ごと完全に削除します。</span>
            <span className="sentence">元に戻せません。</span>
          </p>
          <div className="trash-actions">
            <button type="button" className="button-danger" onClick={() => void onConfirmPurge()} disabled={sending}>
              完全に削除
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={sending}>
              やめる
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
