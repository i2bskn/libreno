import { type ReactNode, useRef, useState } from "react";
import { updatePage } from "../actions";
import { type PageDraft, pageDraftKey } from "../drafts";
import {
  type PageFields,
  type TextSelection,
  folderOptions,
  hasPageChanges,
  insertMarkdown,
  pageChanges,
} from "../edit";
import { spaceDisplayName } from "../format";
import { folderPath } from "../folders";
import { Link } from "../Link";
import { type ApiClient, type PageData, loadPageEditView, useView } from "../load";
import { isValidId, navigate } from "../router";
import { useSidebarActions, useSidebarLocation, viewLocation } from "../sidebarStore";
import { AttachmentsPanel } from "./Attachments";
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

export function PageEditView({
  client,
  id,
  userId,
  origin,
}: {
  client: ApiClient;
  id: string;
  userId: string;
  origin: string;
}) {
  const [state, reload] = useView(() => loadPageEditView(client, id), id);
  useDocumentTitle(viewTitle(state, (data) => `${data.page.title} を編集`));
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
  // A page of an archived space cannot be edited: the form is not shown, so that nothing is typed in vain.
  if (isArchived(state.data.space)) {
    return (
      <main className="main">
        <h1>ページを編集</h1>
        <ArchivedNotice />
        <p>
          <Link to={`/pages/${id}`}>ページへ戻る</Link>
        </p>
      </main>
    );
  }
  // Reloading shows the loading state first, so the form starts again from the latest page.
  return <PageEditForm client={client} id={id} data={state.data} userId={userId} origin={origin} onReload={reload} />;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  // Someone else updated the page after it was loaded.
  | { kind: "conflict" }
  | { kind: "redirecting"; draftSaved: boolean };

const NOT_FOUND_MESSAGE = "このページは見つかりません。削除された可能性があります";
// Updates carry the version, so sending again cannot apply the change twice.
const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。少し待ってからもう一度保存してください";
const CONFLICT_MESSAGE =
  "このページは編集中に他の人に更新されました。入力中の内容はこの画面に残っています。必要なら内容をコピーしてから、最新の内容を読み込んでください";

function PageEditForm({
  client,
  id,
  data,
  userId,
  origin,
  onReload,
}: {
  client: ApiClient;
  id: string;
  data: PageData;
  userId: string;
  origin: string;
  onReload: () => void;
}) {
  const { page, space, folders } = data;
  const original: PageFields = { title: page.title, body: page.body, folderId: page.folder_id };
  const folderIds = folders ? new Set(folders.map((folder) => folder.id)) : null;

  // Without the folders, the folder of the page cannot be changed, so the draft's folder is not used.
  // A folder that is gone becomes the top level.
  function draftFields(draft: PageDraft): PageFields {
    let folderId = draft.folderId;
    if (!folderIds) folderId = page.folder_id;
    else if (folderId !== null && folderId !== page.folder_id && !folderIds.has(folderId)) folderId = null;
    return { title: draft.title, body: draft.body, folderId };
  }

  const form = usePageForm({
    draftKey: pageDraftKey(userId, page.id),
    initial: original,
    isChanged: (fields) => hasPageChanges(pageChanges(original, fields)),
    draftFields,
    baseVersion: page.version,
  });
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const sidebar = useSidebarActions();
  // The draft in use was written on an older version of the page.
  const [draftOutdated, setDraftOutdated] = useState(false);
  // The last selection of the body, where attachments are inserted; null until the body is touched, which
  // inserts at the end. Kept while the preview is shown.
  const bodySelection = useRef<TextSelection | null>(null);
  // Read when an upload ends, which may be after more input.
  const latestFields = useRef(form.fields);
  latestFields.current = form.fields;

  const pagePath = `/pages/${id}`;

  // Inserts like typing: the draft is written and leaving asks first.
  function onInsertAttachment(markdown: string) {
    const fields = latestFields.current;
    const inserted = insertMarkdown(fields.body, bodySelection.current, markdown);
    bodySelection.current = { start: inserted.cursor, end: inserted.cursor };
    const next = { ...fields, body: inserted.body };
    latestFields.current = next;
    form.setFields(next);
  }

  function onApplyDraft() {
    if (form.prompt && form.prompt.draft.baseVersion !== page.version) setDraftOutdated(true);
    form.applyDraft();
  }

  async function onSubmit() {
    if (form.fields.title.trim() === "") {
      setSend({ kind: "error", message: EMPTY_TITLE_MESSAGE });
      return;
    }
    const changes = pageChanges(original, form.fields);
    if (!hasPageChanges(changes)) {
      form.finish();
      navigate(pagePath);
      return;
    }
    const draftSaved = form.syncDraft();
    setSend({ kind: "sending" });
    const result = await updatePage(client, page.id, page.version, changes);
    // The title and the folder may have changed, even when the screen is gone or the result is unknown.
    if (result.kind === "ok" || result.kind === "unknown") sidebar.invalidateSpaceTree(page.space_id);
    if (!form.isMounted()) return;
    switch (result.kind) {
      case "ok":
        form.finish();
        navigate(pagePath);
        return;
      case "conflict":
        setSend({ kind: "conflict" });
        return;
      case "notFound":
        setSend({ kind: "error", message: NOT_FOUND_MESSAGE });
        return;
      case "error":
        setSend({ kind: "error", message: result.message });
        return;
      case "unknown":
        setSend({ kind: "error", message: UNKNOWN_RESULT_MESSAGE });
        return;
      case "redirecting":
        // The move to the login page has started; the form stays disabled.
        setSend({ kind: "redirecting", draftSaved });
        return;
    }
  }

  let folderChoices: FolderChoice[];
  if (!folders || !folderIds) {
    folderChoices = [{ value: folderIdToValue(page.folder_id), label: "現在のフォルダを変えない" }];
  } else {
    folderChoices = [
      { value: folderIdToValue(null), label: TOP_LEVEL_LABEL },
      ...folderOptions(folders).map((option) => ({ value: option.id, label: option.label })),
    ];
    if (page.folder_id !== null && !folderIds.has(page.folder_id)) {
      folderChoices.unshift({ value: page.folder_id, label: "現在のフォルダ（一覧にありません）" });
    }
  }

  let alert: ReactNode | null = null;
  switch (send.kind) {
    case "error":
      alert = <p>{send.message}</p>;
      break;
    case "conflict":
      alert = (
        <p>
          {CONFLICT_MESSAGE}{" "}
          <button type="button" onClick={onReload}>
            最新の内容を読み込む
          </button>
        </p>
      );
      break;
    case "redirecting":
      alert = <p>{redirectingMessage(send.draftSaved)}</p>;
      break;
  }

  const notice = (
    <>
      {form.prompt && (
        <DraftNotice
          prompt={form.prompt}
          note={!folders && form.prompt.draft.folderId !== page.folder_id ? "フォルダの変更は反映していません" : undefined}
          onApply={onApplyDraft}
          onDiscard={form.discardDraft}
        />
      )}
      {draftOutdated && (
        <p className="editor-notice" role="status">
          下書きのあとにページが更新されています。内容を確かめてから保存してください
        </p>
      )}
    </>
  );

  const spaceName = space ? spaceDisplayName(space) : "スペース";
  const path = folders && page.folder_id !== null ? folderPath(folders, page.folder_id) : [];
  return (
    <main className="main">
      <nav className="breadcrumbs" aria-label="パンくずリスト">
        <ol>
          <li>
            <Link to="/">スペース</Link>
          </li>
          <li>{isValidId(page.space_id) ? <Link to={`/spaces/${page.space_id}`}>{spaceName}</Link> : spaceName}</li>
          {path.map((folder) => (
            <li key={folder.id}>
              {isValidId(folder.id) ? <Link to={`/folders/${folder.id}`}>{folder.name}</Link> : folder.name}
            </li>
          ))}
          <li>
            <Link to={pagePath}>{page.title}</Link>
          </li>
          <li aria-current="page">編集</li>
        </ol>
      </nav>
      <h1>ページを編集</h1>
      <PageEditor
        fields={form.fields}
        onChange={form.setFields}
        folderChoices={folderChoices}
        folderLocked={!folders}
        submitLabel="保存"
        sending={send.kind === "sending" || send.kind === "redirecting"}
        locked={form.prompt !== null}
        notice={notice}
        alert={alert}
        draftFailed={form.draftFailed}
        origin={origin}
        attachments={
          <AttachmentsPanel
            client={client}
            pageId={page.id}
            disabled={send.kind === "sending" || send.kind === "redirecting" || form.prompt !== null}
            onInsert={onInsertAttachment}
          />
        }
        onBodySelect={(selection) => {
          bodySelection.current = selection;
        }}
        onSubmit={() => void onSubmit()}
        onCancel={() => navigate(pagePath)}
      />
    </main>
  );
}
