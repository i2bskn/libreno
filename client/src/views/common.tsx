import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import type { Space, SpaceKind } from "../../../src/api/types";
import { SPACE_KIND_LABELS } from "../format";
import { SpaceKindIcon } from "../icons";
import { Link } from "../Link";
import type { ViewState } from "../load";

const APP_NAME = "libreno";

// Sets document.title. null keeps the current title (while loading).
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
}

// The document title for a screen's state. readyTitle is the screen's own title, without the app name.
export function viewTitle<T>(state: ViewState<T>, readyTitle: (data: T) => string | null): string | null {
  switch (state.kind) {
    case "loading":
      return null;
    case "ready": {
      const title = readyTitle(state.data);
      return title === null ? APP_NAME : `${title} - ${APP_NAME}`;
    }
    case "notFound":
      return `見つかりません - ${APP_NAME}`;
    case "error":
    case "redirecting":
      return APP_NAME;
  }
}

// Who can see a space, as a colored label. Each kind has its own color and icon.
export function SpaceKindBadge({ kind }: { kind: SpaceKind }) {
  return (
    <span className={`kind-badge kind-${kind}`}>
      <SpaceKindIcon kind={kind} />
      {SPACE_KIND_LABELS[kind]}
    </span>
  );
}

// Whether the space is archived: its contents are read only. false when the space is not known (null), so that
// the operations are shown and the server decides.
export function isArchived(space: Pick<Space, "archived_at"> | null): boolean {
  return space !== null && space.archived_at !== null;
}

// Shown below the title row of the screens of an archived space, which hide the operations that write.
export function ArchivedNotice() {
  return (
    <p role="note" className="archived-notice">
      このスペースはアーカイブされています。閲覧だけできます。
    </p>
  );
}

// The first item of the breadcrumbs: the archive screen for the screens of an archived space, where the space is
// listed, and the spaces otherwise.
export function BreadcrumbRoot({ archived }: { archived: boolean }) {
  return <li>{archived ? <Link to="/archive">アーカイブ</Link> : <Link to="/">スペース</Link>}</li>;
}

// A small menu that opens below its summary. It closes after a link or button in it is chosen, on a click
// outside it, and on Escape.
export function Menu({
  label,
  summary,
  className,
  children,
}: {
  // The accessible name of the summary, which may show only an icon.
  label: string;
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = ref.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    }
    function onKeyDown(event: KeyboardEvent) {
      const details = ref.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("a, button") && ref.current) ref.current.open = false;
  }

  return (
    <details ref={ref} className={className === undefined ? "menu" : `menu ${className}`}>
      <summary aria-label={label}>{summary}</summary>
      <div className="menu-panel" onClick={onClick}>
        {children}
      </div>
    </details>
  );
}

export function NotFound({ message }: { message: string }) {
  return (
    <main className="main empty-state">
      <h1>{message}</h1>
      <p>
        <Link to="/" className="button">
          スペースの一覧へ
        </Link>
      </p>
    </main>
  );
}

// Shows a state other than ready.
export function ViewStatus({
  state,
  notFoundMessage,
  onReload,
}: {
  state: Exclude<ViewState<unknown>, { kind: "ready" }>;
  notFoundMessage: string;
  onReload: () => void;
}) {
  switch (state.kind) {
    case "loading":
      return (
        <p className="status" role="status">
          読み込み中…
        </p>
      );
    case "redirecting":
      return <p className="status">ログイン画面へ移動しています…</p>;
    case "notFound":
      return <NotFound message={notFoundMessage} />;
    case "error":
      return <LoadError message={state.message} onReload={onReload} />;
  }
}

export function LoadError({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <main className="main empty-state">
      <h1>読み込みに失敗しました</h1>
      <p>{message}</p>
      <button type="button" onClick={onReload}>
        再読み込み
      </button>
    </main>
  );
}
