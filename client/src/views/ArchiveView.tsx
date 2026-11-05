import { formatDateTime, spaceDisplayName } from "../format";
import { ChevronIcon, SpaceKindIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadArchiveView, useView } from "../load";
import { isValidId } from "../router";
import { useSidebarLocation } from "../sidebarStore";
import { SpaceKindBadge, ViewStatus, useDocumentTitle, viewTitle } from "./common";

// The archived spaces, which are not in the sidebar or on the home screen. Their contents are read only.
export function ArchiveView({ client }: { client: ApiClient }) {
  const [state, reload] = useView(() => loadArchiveView(client), "archive");
  useDocumentTitle(viewTitle(state, () => "アーカイブ"));
  useSidebarLocation(null);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const spaces = state.data;
  return (
    <main className="main">
      <h1>アーカイブ</h1>
      <p className="title-note">アーカイブされたスペースです。閲覧だけできます。</p>
      {spaces.length === 0 ? (
        <p className="empty">アーカイブされたスペースはありません</p>
      ) : (
        <ul className="spaces archive-spaces">
          {spaces.map((space) => (
            <li key={space.id} className={`space-card kind-${space.kind}`}>
              <span className="space-card-icon">
                <SpaceKindIcon kind={space.kind} />
              </span>
              <span className="space-card-body">
                <span className="space-name">
                  {isValidId(space.id) ? (
                    <Link to={`/spaces/${space.id}`} className="stretched">
                      {spaceDisplayName(space)}
                    </Link>
                  ) : (
                    spaceDisplayName(space)
                  )}
                </span>
                <span className="space-card-note archive-space-note">
                  <SpaceKindBadge kind={space.kind} />
                  {space.archived_at !== null && (
                    <time dateTime={new Date(space.archived_at).toISOString()}>
                      アーカイブ: {formatDateTime(space.archived_at)}
                    </time>
                  )}
                </span>
              </span>
              {isValidId(space.id) && <ChevronIcon />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
