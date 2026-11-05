import { SPACE_KIND_DESCRIPTIONS, spaceDisplayName } from "../format";
import { childFolders } from "../folders";
import { Link } from "../Link";
import { type ApiClient, loadSpaceView, useView } from "../load";
import { isValidId } from "../router";
import { useSidebarLocation, viewLocation } from "../sidebarStore";
import { TrashIcon } from "../icons";
import {
  ArchivedNotice,
  BreadcrumbRoot,
  SpaceKindBadge,
  ViewStatus,
  isArchived,
  useDocumentTitle,
  viewTitle,
} from "./common";
import { EntryList } from "./EntryList";
import { FolderActions } from "./FolderActions";
import { SpaceActions } from "./SpaceActions";

export function SpaceView({ client, id, isAdmin }: { client: ApiClient; id: string; isAdmin: boolean }) {
  const [state, reload] = useView(() => loadSpaceView(client, id), id);
  useDocumentTitle(viewTitle(state, (data) => spaceDisplayName(data.space)));
  useSidebarLocation(
    viewLocation(state, (data) => ({ spaceId: data.space.id, folderId: null, pageId: null, current: "page" })),
  );

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="スペースが見つかりません" onReload={reload} />;
  }
  const { space, folders, pages } = state.data;
  const name = spaceDisplayName(space);
  const archived = isArchived(space);
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <BreadcrumbRoot archived={archived} />
          <li aria-current="page">{name}</li>
        </ol>
      </nav>
      <div className="title-row">
        <h1>{name}</h1>
        {isAdmin && space.kind !== "personal" && isValidId(space.id) && (
          <SpaceActions client={client} space={space} onReload={reload} />
        )}
        {/* Placed before the forms of SpaceActions by CSS order. */}
        <p className="title-note">
          <SpaceKindBadge kind={space.kind} />
          {SPACE_KIND_DESCRIPTIONS[space.kind]}
        </p>
      </div>
      {archived ? (
        <ArchivedNotice />
      ) : (
        <FolderActions client={client} space={space} folders={folders} folder={null} onReload={reload} />
      )}
      {/* Only the top level; the rest is shown on the folder screens. */}
      <EntryList
        folders={childFolders(folders, null)}
        pages={pages.filter((page) => page.folder_id === null)}
        emptyMessage="ページはまだありません"
      />
      {/* Opened now and then to restore a page, so it is a quiet link below the list rather than a button next
          to the title, where a trash icon reads as deleting the space. */}
      {isValidId(space.id) && (
        <p className="space-footer">
          <Link to={`/spaces/${space.id}/trash`} className="button button-quiet">
            <TrashIcon />
            このスペースのゴミ箱
          </Link>
        </p>
      )}
    </main>
  );
}
