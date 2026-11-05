import { type ReactNode, useState } from "react";
import { createPage } from "../actions";
import { type PageDraft, newPageDraftKey } from "../drafts";
import { type PageFields, folderOptions, hasNewPageInput } from "../edit";
import { spaceDisplayName } from "../format";
import { folderPath } from "../folders";
import { Link } from "../Link";
import { type ApiClient, type PageNewData, loadPageNewView, useView } from "../load";
import { isValidId, navigate } from "../router";
import { useSidebarActions, useSidebarLocation, viewLocation } from "../sidebarStore";
import { ArchivedNotice, ViewStatus, isArchived, useDocumentTitle, viewTitle } from "./common";
import {
  DraftNotice,
  EMPTY_TITLE_MESSAGE,
  type FolderChoice,
  PageEditor,
  TOP_LEVEL_LABEL,
  folderIdToValue,
  redirectingMessage,
  usePageForm,
} from "./PageEditor";

// folderId is the folder from the URL; the page is created at the top level if it is not in the space.
export function PageNewView({
  client,
  spaceId,
  folderId,
  userId,
  origin,
}: {
  client: ApiClient;
  spaceId: string;
  folderId: string | null;
  userId: string;
  origin: string;
}) {
  const [state, reload] = useView(() => loadPageNewView(client, spaceId), `${spaceId}/${folderId ?? ""}`);
  useDocumentTitle(viewTitle(state, () => "新しいページ"));
  useSidebarLocation(
    viewLocation(state, (data) => ({
      spaceId,
      // The same folder as the form starts with: only one of the space.
      folderId: folderId !== null && data.folders.some((folder) => folder.id === folderId) ? folderId : null,
      pageId: null,
      current: "location",
    })),
  );

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="スペースが見つかりません" onReload={reload} />;
  }
  // No page can be created in an archived space: the form is not shown, so that nothing is typed in vain.
  if (isArchived(state.data.space)) {
    return (
      <main className="main">
        <h1>新しいページ</h1>
        <ArchivedNotice />
        {isValidId(spaceId) && (
          <p>
            <Link to={`/spaces/${spaceId}`}>スペースへ戻る</Link>
          </p>
        )}
      </main>
    );
  }
  return (
    <PageNewForm
      client={client}
      spaceId={spaceId}
      folderId={folderId}
      data={state.data}
      userId={userId}
      origin={origin}
    />
  );
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  | { kind: "redirecting"; draftSaved: boolean };

// Creating again could make a second page, so the user is asked to check first.
const UNKNOWN_RESULT_MESSAGE =
  "サーバーに接続できませんでした。スペースを開き直して、ページができていないか確かめてからやり直してください";

function PageNewForm({
  client,
  spaceId,
  folderId,
  data,
  userId,
  origin,
}: {
  client: ApiClient;
  spaceId: string;
  folderId: string | null;
  data: PageNewData;
  userId: string;
  origin: string;
}) {
  const { space, folders } = data;
  const folderIds = new Set(folders.map((folder) => folder.id));
  const initialFolderId = folderId !== null && folderIds.has(folderId) ? folderId : null;
  const initial: PageFields = { title: "", body: "", folderId: initialFolderId };

  // A folder that is gone becomes the top level.
  function draftFields(draft: PageDraft): PageFields {
    const draftFolderId = draft.folderId !== null && folderIds.has(draft.folderId) ? draft.folderId : null;
    return { title: draft.title, body: draft.body, folderId: draftFolderId };
  }

  const form = usePageForm({
    draftKey: newPageDraftKey(userId, spaceId),
    initial,
    isChanged: (fields) => hasNewPageInput(fields, initialFolderId),
    draftFields,
  });
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const sidebar = useSidebarActions();

  const spacePath = `/spaces/${spaceId}`;
  const backPath = initialFolderId !== null && isValidId(initialFolderId) ? `/folders/${initialFolderId}` : spacePath;

  async function onSubmit() {
    if (form.fields.title.trim() === "") {
      setSend({ kind: "error", message: EMPTY_TITLE_MESSAGE });
      return;
    }
    const draftSaved = form.syncDraft();
    setSend({ kind: "sending" });
    // The server trims the title.
    const result = await createPage(client, spaceId, form.fields);
    // Even when the screen is gone. The page may also have been created when the result is unknown.
    if (result.kind === "ok" || result.kind === "unknown") sidebar.invalidateSpaceTree(spaceId);
    if (!form.isMounted()) return;
    switch (result.kind) {
      case "ok":
        form.finish();
        navigate(isValidId(result.page.id) ? `/pages/${result.page.id}` : spacePath);
        return;
      case "notFound":
        setSend({ kind: "error", message: "スペースが見つかりません" });
        return;
      case "error":
        setSend({ kind: "error", message: result.message });
        return;
      case "unknown":
        // The draft is kept: the page may not have been created.
        setSend({ kind: "error", message: UNKNOWN_RESULT_MESSAGE });
        return;
      case "redirecting":
        // The move to the login page has started; the form stays disabled.
        setSend({ kind: "redirecting", draftSaved });
        return;
    }
  }

  const folderChoices: FolderChoice[] = [
    { value: folderIdToValue(null), label: TOP_LEVEL_LABEL },
    ...folderOptions(folders).map((option) => ({ value: option.id, label: option.label })),
  ];

  let alert: ReactNode | null = null;
  if (send.kind === "error") alert = <p>{send.message}</p>;
  else if (send.kind === "redirecting") alert = <p>{redirectingMessage(send.draftSaved)}</p>;

  const spaceName = spaceDisplayName(space);
  const path = initialFolderId !== null ? folderPath(folders, initialFolderId) : [];
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <li>
            <Link to="/">ホーム</Link>
          </li>
          <li>
            <Link to={spacePath}>{spaceName}</Link>
          </li>
          {path.map((folder) => (
            <li key={folder.id}>
              {isValidId(folder.id) ? <Link to={`/folders/${folder.id}`}>{folder.name}</Link> : folder.name}
            </li>
          ))}
          <li aria-current="page">新しいページ</li>
        </ol>
      </nav>
      <h1>新しいページ</h1>
      <PageEditor
        fields={form.fields}
        onChange={form.setFields}
        folderChoices={folderChoices}
        folderLocked={false}
        submitLabel="作成"
        sending={send.kind === "sending" || send.kind === "redirecting"}
        locked={form.prompt !== null}
        notice={
          form.prompt && <DraftNotice prompt={form.prompt} onApply={form.applyDraft} onDiscard={form.discardDraft} />
        }
        alert={alert}
        draftFailed={form.draftFailed}
        origin={origin}
        attachments={<p className="attachments-note">添付ファイルはページを保存したあと、編集画面から追加できます</p>}
        onSubmit={() => void onSubmit()}
        onCancel={() => navigate(backPath)}
      />
    </main>
  );
}
