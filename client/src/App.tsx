import { type FormEvent, useEffect, useRef } from "react";
import type { User } from "../../src/api/types";
import { createApiClient, createApiFetch, unexpectedResponseMessage } from "./api";
import { BrandLogo } from "./brand";
import { LogoutIcon, SearchIcon, SidebarIcon, UsersIcon } from "./icons";
import { Link } from "./Link";
import { loadMe, useView } from "./load";
import { type Route, matchRoute, navigate, usePath } from "./router";
import { SidebarProvider, useSidebarActions, useSidebarLocation } from "./sidebarStore";
import { markLeaving } from "./unload";
import { LoadError, Menu, NotFound, useDocumentTitle } from "./views/common";
import { ArchiveView } from "./views/ArchiveView";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { FolderView } from "./views/FolderView";
import { HomeView } from "./views/HomeView";
import { PageEditView } from "./views/PageEditView";
import { PageHistoryView } from "./views/PageHistoryView";
import { PageNewView } from "./views/PageNewView";
import { PageRevisionView } from "./views/PageRevisionView";
import { PageView } from "./views/PageView";
import { SearchView } from "./views/SearchView";
import { Sidebar } from "./views/Sidebar";
import { SpaceView } from "./views/SpaceView";
import { TrashView } from "./views/TrashView";
import { UsersView } from "./views/UsersView";

// One client for every screen: the shared refresh and the single move to the login page are per instance.
const client = createApiClient(
  createApiFetch({
    fetch: globalThis.fetch.bind(globalThis),
    redirectToLogin: (url) => {
      markLeaving();
      location.assign(url);
    },
    currentPath: () => location.pathname + location.search,
  }),
);

export function App() {
  // Loaded once; moving between screens does not load it again. Screens load their data after it.
  const [me, reload] = useView(() => loadMe(client), "me");
  const path = usePath();
  const route = matchRoute(path);

  switch (me.kind) {
    case "loading":
      return <p className="status">読み込み中…</p>;
    case "redirecting":
      return <p className="status">ログイン画面へ移動しています…</p>;
    case "error":
      return <LoadError message={me.message} onReload={reload} />;
    case "notFound":
      // loadMe reports a 404 as an error; this case only completes the switch.
      return <LoadError message={unexpectedResponseMessage(404)} onReload={reload} />;
    case "ready":
      // The sidebar keeps what it has loaded and which rows are open across screens, so the provider and the
      // sidebar are outside the boundary that is reset on every screen.
      return (
        <SidebarProvider client={client}>
          <Header user={me.data} route={route} path={path} />
          <div className="layout">
            <ErrorBoundary fallback={<p className="sidebar-status">ページ一覧を表示できませんでした</p>}>
              <Sidebar path={path} />
            </ErrorBoundary>
            <div className="layout-screen">
              <ErrorBoundary key={path}>
                <Screen route={route} user={me.data} />
              </ErrorBoundary>
            </div>
          </div>
        </SidebarProvider>
      );
  }
}

function Screen({ route, user }: { route: Route; user: User }) {
  switch (route.name) {
    case "home":
      return <HomeView client={client} isAdmin={user.role === "admin"} origin={location.origin} />;
    case "space":
      return <SpaceView client={client} id={route.id} isAdmin={user.role === "admin"} />;
    case "trash":
      return <TrashView client={client} id={route.id} isAdmin={user.role === "admin"} />;
    case "folder":
      return <FolderView client={client} id={route.id} />;
    case "page":
      return <PageView client={client} id={route.id} origin={location.origin} isAdmin={user.role === "admin"} />;
    case "pageHistory":
      return <PageHistoryView client={client} id={route.id} />;
    case "pageRevision":
      return <PageRevisionView client={client} id={route.id} version={route.version} origin={location.origin} />;
    case "pageNew":
      return (
        <PageNewView
          client={client}
          spaceId={route.spaceId}
          folderId={route.folderId}
          userId={user.id}
          origin={location.origin}
        />
      );
    case "pageEdit":
      return <PageEditView client={client} id={route.id} userId={user.id} origin={location.origin} />;
    case "search":
      return <SearchView client={client} query={route.query} />;
    case "users":
      return <UsersView client={client} currentUserId={user.id} />;
    case "archive":
      return <ArchiveView client={client} />;
    case "notFound":
      return <RouteNotFound />;
  }
}

function RouteNotFound() {
  useDocumentTitle("見つかりません - libreno");
  useSidebarLocation(null);
  return <NotFound message="ページが見つかりません" />;
}

function Header({ user, route, path }: { user: User; route: Route; path: string }) {
  // The search screen shows its query; other screens start empty.
  const query = route.name === "search" ? route.query : "";
  const search = useRef<HTMLInputElement>(null);
  const { openDrawer } = useSidebarActions();

  // "/" moves to the search field, unless the user is typing somewhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]"))
      ) {
        return;
      }
      event.preventDefault();
      search.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("q");
    const q = typeof value === "string" ? value.trim() : "";
    if (q === "") return;
    search.current?.blur();
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  const name = user.name ?? user.email;
  return (
    <header className="header">
      <div className="header-inner">
        {/* Shown only on a narrow window, where the list of pages is not next to the screen. */}
        <button type="button" className="sidebar-open" aria-label="ページ一覧" onClick={openDrawer}>
          <SidebarIcon />
        </button>
        <Link to="/" className="brand">
          <BrandLogo />
          <span className="sr-only">libreno</span>
        </Link>
        {/* action and method are used when JavaScript does not run; /search is served by the SPA. */}
        <form role="search" className="search-form" action="/search" method="get" onSubmit={onSearch}>
          <SearchIcon />
          <input
            ref={search}
            key={query}
            type="search"
            name="q"
            aria-label="ページを検索"
            placeholder="ページを検索"
            maxLength={100}
            enterKeyHint="search"
            defaultValue={query}
          />
          <kbd className="search-key" aria-hidden="true">
            /
          </kbd>
          <button type="submit" className="search-submit">
            検索
          </button>
        </form>
        {/* Keyed by the path, so that it is closed again on every screen. */}
        <Menu
          key={path}
          className="account-menu"
          label={`アカウント: ${name}`}
          summary={
            <>
              <span className="avatar" aria-hidden="true">
                {Array.from(name)[0]?.toUpperCase()}
              </span>
              <span className="account-name">{name}</span>
            </>
          }
        >
          <div className="account-card">
            <span className="account-card-name">{name}</span>
            {user.name !== null && <span className="account-card-email">{user.email}</span>}
            <span className="account-card-role">{user.role === "admin" ? "管理者" : "一般"}</span>
          </div>
          {/* Shown only to admins; the server checks it again. */}
          {user.role === "admin" && (
            <Link to="/users" className="menu-item">
              <UsersIcon />
              ユーザー管理
            </Link>
          )}
          <form method="post" action="/auth/logout">
            <button type="submit" className="menu-item">
              <LogoutIcon />
              ログアウト
            </button>
          </form>
        </Menu>
      </div>
    </header>
  );
}
