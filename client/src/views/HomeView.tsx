import { type FormEvent, useState } from "react";
import type { CreateSpaceRequest, Page } from "../../../src/api/types";
import { createSpace, setTopPage } from "../actions";
import {
  CREATABLE_SPACE_KINDS,
  SPACE_KIND_DESCRIPTIONS,
  SPACE_KIND_LABELS,
  isCreatableSpaceKind,
  spaceDisplayName,
} from "../format";
import { ChevronIcon, PlusIcon, SpaceKindIcon } from "../icons";
import { Link } from "../Link";
import { type ApiClient, loadHomeView, useView } from "../load";
import { Markdown } from "../Markdown";
import { isValidId, navigate } from "../router";
import { useSidebarActions, useSidebarLocation, viewLocation } from "../sidebarStore";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";
import { MemberPicker, selectedUserIds, useUserList } from "./MemberPicker";

const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";

export function HomeView({ client, isAdmin, origin }: { client: ApiClient; isAdmin: boolean; origin: string }) {
  const [state, reload] = useView(() => loadHomeView(client), "home");
  useDocumentTitle(viewTitle(state, () => null));
  useSidebarLocation(null);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { spaces, topPage, topPageError } = state.data;
  return (
    <main className="main home">
      {topPage !== null && (
        <TopPage client={client} page={topPage} isAdmin={isAdmin} origin={origin} onReload={reload} />
      )}
      {topPageError && <p className="notice">トップのページを読み込めませんでした</p>}
      {topPage === null && !topPageError && isAdmin && (
        <div className="notice top-page-help">
          <p>
            トップにはページが表示されていません。全員スペースのページを開いて「トップに表示」を押すと、ここに表示されます。設定したページを全員スペース以外へ移したりゴミ箱に入れたりした場合も表示されず、戻すとまた表示されます
          </p>
          {/* Clears a setting whose page is hidden; harmless when nothing is set. */}
          <ClearTopPage client={client} label="設定を外す" onReload={reload} />
        </div>
      )}
      <div className="section-head">
        {topPage !== null ? <h2 className="spaces-heading">スペース</h2> : <h1 className="spaces-heading">スペース</h1>}
        {isAdmin && <CreateSpace client={client} onReload={reload} />}
      </div>
      {spaces.length === 0 ? (
        <p className="empty">スペースがありません</p>
      ) : (
        <ul className="spaces">
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
                <span className="space-card-note">{SPACE_KIND_DESCRIPTIONS[space.kind]}</span>
              </span>
              {isValidId(space.id) && <ChevronIcon />}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// The page chosen by an admin, shown above the spaces to everyone the same way.
function TopPage({
  client,
  page,
  isAdmin,
  origin,
  onReload,
}: {
  client: ApiClient;
  page: Page;
  isAdmin: boolean;
  origin: string;
  onReload: () => void;
}) {
  return (
    <section className="top-page" aria-label="トップのページ">
      <h1 className="top-page-title">
        {isValidId(page.id) ? <Link to={`/pages/${page.id}`}>{page.title}</Link> : page.title}
      </h1>
      <Markdown body={page.body} origin={origin} />
      {/* Set apart from the body, so that they do not read as part of the page. */}
      {(isValidId(page.id) || isAdmin) && (
        <div className="top-page-footer">
          {isValidId(page.id) && (
            <Link to={`/pages/${page.id}`} className="top-page-open">
              ページを開く
              <ChevronIcon />
            </Link>
          )}
          {isAdmin && <ClearTopPage client={client} label="トップから外す" onReload={onReload} />}
        </div>
      )}
    </section>
  );
}

type ClearTopPageState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  // The move to the login page has started; the button stays disabled.
  | { kind: "redirecting" };

// The button for admins to clear the top page setting. The screen is loaded again after it is cleared.
function ClearTopPage({ client, label, onReload }: { client: ApiClient; label: string; onReload: () => void }) {
  const [state, setState] = useState<ClearTopPageState>({ kind: "idle" });

  async function onClear() {
    setState({ kind: "sending" });
    const result = await setTopPage(client, null);
    switch (result.kind) {
      case "ok":
        onReload();
        return;
      case "error":
        setState({ kind: "error", message: result.message });
        return;
      case "unknown":
        setState({ kind: "error", message: UNKNOWN_RESULT_MESSAGE });
        return;
      case "redirecting":
        setState({ kind: "redirecting" });
        return;
    }
  }

  return (
    <div className="actions">
      <button
        type="button"
        className="button-quiet"
        onClick={() => void onClear()}
        disabled={state.kind === "sending" || state.kind === "redirecting"}
      >
        {label}
      </button>
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </div>
  );
}

// The button and form for admins to create a space that everyone, only admins, or the chosen members and admins
// can see. The users to choose members from are loaded only when the members kind is chosen.
function CreateSpace({ client, onReload }: { client: ApiClient; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [kind, setKind] = useState<CreateSpaceRequest["kind"]>("everyone");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const users = useUserList(client, open && kind === "members");
  const sidebar = useSidebarActions();

  function openForm() {
    setOpen(true);
    setFailure(null);
    setKind("everyone");
    setName("");
    setMembers(new Set());
  }

  function close() {
    setOpen(false);
    setFailure(null);
  }

  async function submit() {
    // Members are chosen from the users; without them there is nothing to send yet.
    if (kind === "members" && users.kind !== "ok") return;
    setSending(true);
    setFailure(null);
    const result = await createSpace(
      client,
      users.kind === "ok" ? { kind, name, memberIds: selectedUserIds(users.value, members) } : { kind, name },
    );
    // The space may also have been created when the result is unknown.
    if (result.kind === "ok" || result.kind === "unknown") sidebar.invalidateSpaces();
    switch (result.kind) {
      case "ok":
        if (isValidId(result.space.id)) {
          // The buttons stay disabled until the screen changes.
          navigate(`/spaces/${result.space.id}`);
          return;
        }
        setSending(false);
        setOpen(false);
        onReload();
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <>
      <button type="button" onClick={openForm} disabled={sending}>
        <PlusIcon />
        スペースを作成
      </button>
      {open && (
        <form className="folder-form" aria-label="スペースを作成" onSubmit={onSubmit}>
          <label>
            スペースの名前
            {/* The form is opened by the button just before it, to type the name. */}
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={sending}
              autoFocus
            />
          </label>
          {/* Who can see it is the point of a space, so each choice says it in a sentence. */}
          <fieldset className="kind-choices">
            <legend>見られる人</legend>
            {CREATABLE_SPACE_KINDS.map((option) => (
              <label key={option} className={`kind-choice kind-${option}`}>
                <input
                  type="radio"
                  name="kind"
                  value={option}
                  checked={kind === option}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (isCreatableSpaceKind(value)) setKind(value);
                  }}
                  disabled={sending}
                />
                <span className="space-card-icon">
                  <SpaceKindIcon kind={option} />
                </span>
                <span className="kind-choice-text">
                  <span className="kind-choice-label">{SPACE_KIND_LABELS[option]}</span>
                  <span className="kind-choice-note">{SPACE_KIND_DESCRIPTIONS[option]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {kind === "members" && (
            <MemberPicker users={users} selected={members} onChange={setMembers} disabled={sending} />
          )}
          <div className="folder-form-actions">
            {/* Members are chosen from the users, so a members space waits for them to load. */}
            <button type="submit" disabled={sending || (kind === "members" && users.kind !== "ok")}>
              作成
            </button>
            <button type="button" onClick={close} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </>
  );
}
