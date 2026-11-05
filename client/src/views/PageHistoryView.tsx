import { formatDateTime, spaceDisplayName } from "../format";
import { ChevronIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadPageHistoryView, useView } from "../load";
import { isValidId } from "../router";
import { useSidebarLocation, viewLocation } from "../sidebarStore";
import { ArchivedNotice, BreadcrumbRoot, ViewStatus, isArchived, useDocumentTitle, viewTitle } from "./common";

export function PageHistoryView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadPageHistoryView(client, id), id);
  useDocumentTitle(viewTitle(state, (data) => `${data.page.title} の履歴`));
  useSidebarLocation(
    viewLocation(state, ({ page }) => ({
      spaceId: page.space_id,
      folderId: page.folder_id,
      pageId: page.id,
      current: "location",
    })),
  );

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { page, space, revisions } = state.data;
  const spaceName = space ? spaceDisplayName(space) : "スペース";
  const archived = isArchived(space);
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <BreadcrumbRoot archived={archived} />
          <li>{isValidId(page.space_id) ? <Link to={`/spaces/${page.space_id}`}>{spaceName}</Link> : spaceName}</li>
          <li>
            <Link to={`/pages/${id}`}>{page.title}</Link>
          </li>
          <li aria-current="page">履歴</li>
        </ol>
      </nav>
      <h1>「{page.title}」の履歴</h1>
      {archived && <ArchivedNotice />}
      {/* Every row has the version, its title and when it was saved, and opens that version. */}
      <ul className="revisions">
        <li>
          <span className="revision-title">
            <Link to={`/pages/${id}`} className="stretched">
              版 {page.version}
            </Link>
            <span className="revision-current">現在の版</span>
          </span>
          <span className="revision-detail">{page.title}</span>
          <time className="page-updated" dateTime={new Date(page.updated_at).toISOString()}>
            保存: {formatDateTime(page.updated_at)}
          </time>
          <ChevronIcon />
        </li>
        {revisions.map((revision) => (
          <li key={revision.version}>
            <span className="revision-title">
              <Link to={`/pages/${id}/revisions/${revision.version}`} className="stretched">
                版 {revision.version}
              </Link>
            </span>
            <span className="revision-detail">{revision.title}</span>
            <time className="page-updated" dateTime={new Date(revision.created_at).toISOString()}>
              保存: {formatDateTime(revision.created_at)}
            </time>
            <ChevronIcon />
          </li>
        ))}
      </ul>
      {revisions.length === 0 && <p className="empty">以前の版はありません</p>}
      <p className="title-note">新しい&nbsp;20&nbsp;版まで保存されます</p>
    </main>
  );
}
