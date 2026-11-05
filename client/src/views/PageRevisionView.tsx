import { useState } from "react";
import type { Page, PageRevision } from "../../../src/api/types";
import { restoreRevision } from "../actions";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { type ApiClient, loadPageRevisionView, useView } from "../load";
import { Markdown } from "../Markdown";
import { navigate } from "../router";
import { useSidebarActions, useSidebarLocation, viewLocation } from "../sidebarStore";
import { ArchivedNotice, ViewStatus, isArchived, useDocumentTitle, viewTitle } from "./common";

export function PageRevisionView({
  client,
  id,
  version,
  origin,
}: {
  client: ApiClient;
  id: string;
  version: number;
  origin: string;
}) {
  const [state, reload] = useView(() => loadPageRevisionView(client, id, version), `${id}/${version}`);
  useDocumentTitle(viewTitle(state, (data) => `${data.page.title} の版 ${data.revision.version}`));
  useSidebarLocation(
    viewLocation(state, ({ page }) => ({
      spaceId: page.space_id,
      folderId: page.folder_id,
      pageId: page.id,
      current: "location",
    })),
  );

  if (state.kind !== "ready") {
    // A missing page and a missing revision share the message: a screen has one not found message.
    return <ViewStatus state={state} notFoundMessage="この版は見つかりません" onReload={reload} />;
  }
  const { page, space, revision } = state.data;
  // A page of an archived space cannot go back to a revision. When the space could not be loaded, the button
  // is shown and the server decides.
  const archived = isArchived(space);
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <li>
            <Link to={`/pages/${id}`}>{page.title}</Link>
          </li>
          <li>
            <Link to={`/pages/${id}/history`}>履歴</Link>
          </li>
          <li aria-current="page">版 {revision.version}</li>
        </ol>
      </nav>
      <div className="revision-notice">
        <p>
          この版は過去の内容です。<Link to={`/pages/${id}`}>現在のページ</Link>・
          <Link to={`/pages/${id}/history`}>履歴の一覧</Link>
        </p>
        {!archived && <RestoreRevision client={client} page={page} revision={revision} onReload={reload} />}
      </div>
      <h1>版 {revision.version}</h1>
      {archived && <ArchivedNotice />}
      <p className="page-meta">
        保存: <time dateTime={new Date(revision.created_at).toISOString()}>{formatDateTime(revision.created_at)}</time>
      </p>
      <h2 className="revision-page-title">{revision.title}</h2>
      <Markdown body={revision.body} origin={origin} />
    </main>
  );
}

type RestoreState =
  | { kind: "closed" }
  | { kind: "confirming" }
  | { kind: "sending" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

const UNKNOWN_RESULT_MESSAGE =
  "サーバーに接続できませんでした。ページを開き直して、戻っているか確かめてからやり直してください";

function RestoreRevision({
  client,
  page,
  revision,
  onReload,
}: {
  client: ApiClient;
  page: Page;
  revision: PageRevision;
  onReload: () => void;
}) {
  const [state, setState] = useState<RestoreState>({ kind: "closed" });
  const sidebar = useSidebarActions();

  async function onRestore() {
    setState({ kind: "sending" });
    const result = await restoreRevision(client, page.id, revision.version, page.version);
    // The title may have changed; the restore may also have happened when the result is unknown.
    if (result.kind === "ok" || result.kind === "unknown") sidebar.invalidateSpaceTree(page.space_id);
    switch (result.kind) {
      case "ok":
        navigate(`/pages/${page.id}`);
        return;
      case "conflict":
        setState({ kind: "conflict" });
        return;
      case "error":
        setState({ kind: "error", message: result.message });
        return;
      case "unknown":
        setState({ kind: "error", message: UNKNOWN_RESULT_MESSAGE });
        return;
      case "redirecting":
        // The move to the login page has started; the button stays disabled.
        return;
    }
  }

  function onReloadPage() {
    setState({ kind: "closed" });
    onReload();
  }

  if (state.kind === "closed") {
    return (
      <p>
        <button type="button" onClick={() => setState({ kind: "confirming" })}>
          この版に戻す
        </button>
      </p>
    );
  }
  const sending = state.kind === "sending";
  return (
    <div className="restore-confirm" role="group" aria-label="この版に戻す">
      <p>現在の内容を履歴に残して、この版の内容に戻します。</p>
      <div className="restore-actions">
        <button type="button" className="button-primary" onClick={() => void onRestore()} disabled={sending}>
          戻す
        </button>
        <button type="button" onClick={() => setState({ kind: "closed" })} disabled={sending}>
          やめる
        </button>
      </div>
      {state.kind === "conflict" && (
        <p role="alert">
          ページが他の人に更新されています。最新の内容を読み込み直してからやり直してください{" "}
          <button type="button" onClick={onReloadPage}>
            読み込み直す
          </button>
        </p>
      )}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </div>
  );
}
