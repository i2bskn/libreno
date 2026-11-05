import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import type { Space } from "../../../src/api/types";
import { spaceDisplayName } from "../format";
import { ChevronIcon, CloseIcon, FolderIcon, PageIcon, ReloadIcon, SpaceKindIcon } from "../icons";
import { Link } from "../Link";
import { isValidId } from "../router";
import { type TreeNode, buildSpaceTree } from "../sidebar";
import { type SidebarLocation, folderKey, locationKey, spaceKey, useSidebar } from "../sidebarStore";

// The tree of spaces, folders and pages: next to the screen on a wide window, and in a drawer opened from the
// header otherwise. Both show the same rows, open and closed alike.
export function Sidebar({ path }: { path: string }) {
  const { wide } = useSidebar();
  return (
    <>
      {/* Drawn only on a wide window, so that a narrow one does not load the lists until the drawer is opened. */}
      {wide && <SidebarAside path={path} />}
      <SidebarDrawer path={path} />
    </>
  );
}

function SidebarAside({ path }: { path: string }) {
  const ref = useRef<HTMLElement>(null);
  const { location } = useSidebar();
  const key = locationKey(location);
  // The location whose row was scrolled to; it is scrolled to once, when it is first drawn.
  const scrolledFor = useRef<string | null>(null);

  // Runs after every render: the row of the location may be drawn only after its tree is loaded.
  useEffect(() => {
    if (location === null || scrolledFor.current === key) return;
    const row = ref.current?.querySelector("[aria-current]");
    if (!row) return;
    scrolledFor.current = key;
    row.scrollIntoView({ block: "nearest" });
  });

  return (
    <aside ref={ref} className="sidebar">
      <SidebarTree path={path} />
    </aside>
  );
}

// A modal dialog from the left side. It closes on its close button, on Escape, on a click outside it and when a
// link in it is chosen.
function SidebarDrawer({ path }: { path: string }) {
  const { drawerOpen, closeDrawer } = useSidebar();
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) {
      dialog.showModal();
      // The browser moves the focus back to the button that opened it when it closes.
      const current = dialog.querySelector<HTMLElement>("[aria-current]");
      (current ?? closeButton.current)?.focus();
    } else if (!drawerOpen && dialog.open) {
      dialog.close();
    }
  }, [drawerOpen]);

  // A link chosen in the drawer changed the screen.
  useEffect(() => {
    closeDrawer();
  }, [path]);

  function onClick(event: MouseEvent<HTMLDialogElement>) {
    // The dialog itself is hit only outside its content, on the backdrop.
    if (event.target === event.currentTarget) {
      closeDrawer();
      return;
    }
    // A link to the screen shown does not change the path, so it is closed here. A move cancelled by the guard of
    // unsaved changes keeps both the path and the drawer.
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (link && link.getAttribute("href") === path) closeDrawer();
  }

  return (
    <dialog ref={ref} className="sidebar-drawer" aria-labelledby={headingId} onClose={closeDrawer} onClick={onClick}>
      {/* Drawn only while open, so that the lists are loaded only when they are seen. */}
      {drawerOpen && (
        <div className="sidebar-drawer-inner">
          <div className="sidebar-drawer-head">
            <h2 id={headingId}>ページ一覧</h2>
            <button
              ref={closeButton}
              type="button"
              className="sidebar-icon-button"
              aria-label="閉じる"
              onClick={closeDrawer}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="sidebar-drawer-body">
            <SidebarTree path={path} />
          </div>
        </div>
      )}
    </dialog>
  );
}

// path is the path of the screen shown, with the search part if any.
function SidebarTree({ path }: { path: string }) {
  const { spaces, reloadAll, invalidateSpaces } = useSidebar();
  let body: ReactNode;
  if (spaces.data === null) {
    body = spaces.failed ? (
      <Failed message="スペースを読み込めませんでした" depth={0} onReload={invalidateSpaces} />
    ) : (
      <p className="sidebar-status">読み込み中…</p>
    );
  } else {
    body = (
      <>
        {spaces.failed && <Failed message="スペースを読み込めませんでした" depth={0} onReload={invalidateSpaces} />}
        {spaces.data.length === 0 ? (
          <p className="sidebar-status">スペースはまだありません</p>
        ) : (
          <ul className="sidebar-tree">
            {spaces.data.map((space) => (
              <SpaceItem key={space.id} space={space} />
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <nav className="sidebar-nav" aria-label="ページ一覧">
      <div className="sidebar-head">
        <h2 className="sidebar-heading">スペース</h2>
        <button type="button" className="sidebar-icon-button" aria-label="ページ一覧を読み込み直す" onClick={reloadAll}>
          <ReloadIcon />
        </button>
      </div>
      {body}
      {/* Archived spaces are not in the tree; they are listed on the archive screen only. Shown even when there
          are none, so that the place to look is always the same. */}
      <Link
        to="/archive"
        className="sidebar-archive-link"
        aria-current={pathnameOf(path) === "/archive" ? "page" : undefined}
      >
        アーカイブ
      </Link>
    </nav>
  );
}

function pathnameOf(path: string): string {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
}

function SpaceItem({ space }: { space: Space }) {
  const { trees, expanded, location, toggle, invalidateSpaceTree } = useSidebar();
  const open = expanded.has(spaceKey(space.id));
  const cache = trees.get(space.id);
  const data = cache?.data ?? null;
  const nodes = useMemo(() => (data ? buildSpaceTree(data.folders, data.pages) : null), [data]);
  const name = spaceDisplayName(space);
  // The location inside this space, if any.
  const here = location !== null && location.spaceId === space.id ? location : null;
  const current = here !== null && here.folderId === null && here.pageId === null ? here.current : undefined;

  let children: ReactNode = null;
  if (open) {
    if (nodes === null) {
      children = cache?.failed ? (
        <Failed message="読み込めませんでした" depth={1} onReload={() => invalidateSpaceTree(space.id)} />
      ) : (
        <p className="sidebar-status" style={depthStyle(1)}>
          読み込み中…
        </p>
      );
    } else {
      children = (
        <>
          {cache?.failed && <Failed message="読み込めませんでした" depth={1} onReload={() => invalidateSpaceTree(space.id)} />}
          {nodes.length === 0 ? (
            <p className="sidebar-status" style={depthStyle(1)}>
              ページはまだありません
            </p>
          ) : (
            <TreeList nodes={nodes} depth={1} location={here} />
          )}
        </>
      );
    }
  }

  return (
    <li className={`sidebar-space kind-${space.kind}`}>
      <Row
        depth={0}
        toggle={{ open, onToggle: () => toggle(spaceKey(space.id)) }}
        icon={<SpaceKindIcon kind={space.kind} />}
        to={isValidId(space.id) ? `/spaces/${space.id}` : null}
        label={name}
        current={current}
      />
      {children}
    </li>
  );
}

function TreeList({ nodes, depth, location }: { nodes: TreeNode[]; depth: number; location: SidebarLocation | null }) {
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <FolderItem key={`folder:${node.folder.id}`} node={node} depth={depth} location={location} />
        ) : (
          <li key={`page:${node.page.id}`}>
            <Row
              depth={depth}
              toggle={null}
              icon={<PageIcon />}
              to={isValidId(node.page.id) ? `/pages/${node.page.id}` : null}
              label={node.page.title}
              current={location !== null && location.pageId === node.page.id ? location.current : undefined}
            />
          </li>
        ),
      )}
    </ul>
  );
}

function FolderItem({
  node,
  depth,
  location,
}: {
  node: Extract<TreeNode, { kind: "folder" }>;
  depth: number;
  location: SidebarLocation | null;
}) {
  const { expanded, toggle } = useSidebar();
  const { folder, children } = node;
  const key = folderKey(folder.id);
  const open = expanded.has(key);
  // A page is the location when there is one; its folder is then only opened.
  const current =
    location !== null && location.pageId === null && location.folderId === folder.id ? location.current : undefined;
  return (
    <li>
      <Row
        depth={depth}
        toggle={{ open, onToggle: () => toggle(key) }}
        icon={<FolderIcon />}
        to={isValidId(folder.id) ? `/folders/${folder.id}` : null}
        label={folder.name}
        current={current}
      />
      {open && children.length > 0 && <TreeList nodes={children} depth={depth + 1} location={location} />}
    </li>
  );
}

// One row: the button that opens and closes it (or the same space without one, for a page), the icon and the
// name. The name is a link, apart from the button, unless the id cannot be put into a path.
function Row({
  depth,
  toggle,
  icon,
  to,
  label,
  current,
}: {
  depth: number;
  toggle: { open: boolean; onToggle: () => void } | null;
  icon: ReactNode;
  to: string | null;
  label: string;
  current: "page" | "location" | undefined;
}) {
  return (
    <div className="sidebar-row" style={depthStyle(depth)}>
      {toggle ? (
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={toggle.open}
          aria-label={toggle.open ? `${label}を閉じる` : `${label}を開く`}
          onClick={toggle.onToggle}
        >
          <ChevronIcon />
        </button>
      ) : (
        <span className="sidebar-toggle-space" />
      )}
      {icon}
      {to !== null ? (
        <Link to={to} className="sidebar-link" title={label} aria-current={current}>
          {label}
        </Link>
      ) : (
        <span className="sidebar-link" title={label}>
          {label}
        </span>
      )}
    </div>
  );
}

function Failed({ message, depth, onReload }: { message: string; depth: number; onReload: () => void }) {
  return (
    <p className="sidebar-status sidebar-failed" style={depthStyle(depth)}>
      {message}
      <button type="button" onClick={onReload}>
        再読み込み
      </button>
    </p>
  );
}

// The indent of a row, read by the stylesheet.
function depthStyle(depth: number): CSSProperties {
  return { "--depth": depth } as CSSProperties;
}
