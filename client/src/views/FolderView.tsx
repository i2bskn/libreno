import { SPACE_KIND_DESCRIPTIONS, spaceDisplayName } from "../format";
import { childFolders, folderPath } from "../folders";
import { Link } from "../Link";
import { type ApiClient, loadFolderView, useView } from "../load";
import { isValidId } from "../router";
import { useSidebarLocation, viewLocation } from "../sidebarStore";
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

export function FolderView({ client, id }: { client: ApiClient; id: string }) {
  const [state, reload] = useView(() => loadFolderView(client, id), id);
  useDocumentTitle(viewTitle(state, (data) => data.folder.name));
  useSidebarLocation(
    viewLocation(state, (data) => ({ spaceId: data.space.id, folderId: data.folder.id, pageId: null, current: "page" })),
  );

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="フォルダが見つかりません" onReload={reload} />;
  }
  const { folder, space, folders, pages } = state.data;
  const spaceName = spaceDisplayName(space);
  // Without the folder itself. Empty if the folder list is older than the folder.
  const ancestors = folderPath(folders, folder.id).slice(0, -1);
  const archived = isArchived(space);
  const heading = (
    <>
      <h1>{folder.name}</h1>
      <p className="title-note">
        <SpaceKindBadge kind={space.kind} />
        {SPACE_KIND_DESCRIPTIONS[space.kind]}
      </p>
    </>
  );
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <BreadcrumbRoot archived={archived} />
          <li>{isValidId(space.id) ? <Link to={`/spaces/${space.id}`}>{spaceName}</Link> : spaceName}</li>
          {ancestors.map((ancestor) => (
            <li key={ancestor.id}>
              {isValidId(ancestor.id) ? <Link to={`/folders/${ancestor.id}`}>{ancestor.name}</Link> : ancestor.name}
            </li>
          ))}
          <li aria-current="page">{folder.name}</li>
        </ol>
      </nav>
      {archived ? (
        <>
          <div className="title-row">{heading}</div>
          <ArchivedNotice />
        </>
      ) : (
        <FolderActions
          client={client}
          space={space}
          folders={folders}
          folder={folder}
          heading={heading}
          onReload={reload}
        />
      )}
      <EntryList
        folders={childFolders(folders, folder.id)}
        pages={pages.filter((page) => page.folder_id === folder.id)}
        emptyMessage="このフォルダは空です"
      />
    </main>
  );
}
