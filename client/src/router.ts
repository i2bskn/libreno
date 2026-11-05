import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "space"; id: string }
  | { name: "trash"; id: string }
  | { name: "folder"; id: string }
  | { name: "page"; id: string }
  | { name: "pageHistory"; id: string }
  | { name: "pageRevision"; id: string; version: number }
  // folderId is the folder to create the page in, from ?folder=; null when missing or invalid.
  | { name: "pageNew"; spaceId: string; folderId: string | null }
  | { name: "pageEdit"; id: string }
  | { name: "search"; query: string }
  | { name: "users" }
  | { name: "archive" }
  | { name: "notFound" };

// hc() puts params into the URL without encoding them, so IDs are limited to characters that cannot
// change the path (no "/", "." or "%"). Server IDs are UUIDs, which always match.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Whether an ID may be put into a link or an API URL. Not decoded first.
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

const ROUTE_PATTERN = /^\/(spaces|folders|pages)\/([^/]+)$/;
const PAGE_HISTORY_PATTERN = /^\/pages\/([^/]+)\/history$/;
const PAGE_EDIT_PATTERN = /^\/pages\/([^/]+)\/edit$/;
const PAGE_REVISION_PATTERN = /^\/pages\/([^/]+)\/revisions\/([^/]+)$/;
const TRASH_PATTERN = /^\/spaces\/([^/]+)\/trash$/;
const PAGE_NEW_PATTERN = /^\/spaces\/([^/]+)\/new$/;

// A page version in a path: an integer of 1 or more, without leading zeros. null otherwise.
function parseVersion(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

function matchPageSubroute(pathname: string): Route | null {
  const history = PAGE_HISTORY_PATTERN.exec(pathname);
  if (history) {
    const [, id] = history;
    return id !== undefined && isValidId(id) ? { name: "pageHistory", id } : { name: "notFound" };
  }
  const edit = PAGE_EDIT_PATTERN.exec(pathname);
  if (edit) {
    const [, id] = edit;
    return id !== undefined && isValidId(id) ? { name: "pageEdit", id } : { name: "notFound" };
  }
  const revision = PAGE_REVISION_PATTERN.exec(pathname);
  if (revision) {
    const [, id, value] = revision;
    const version = value === undefined ? null : parseVersion(value);
    return id !== undefined && isValidId(id) && version !== null
      ? { name: "pageRevision", id, version }
      : { name: "notFound" };
  }
  return null;
}

// path is the pathname followed by the search part, if any. Only /search and /spaces/:id/new read the
// search part.
export function matchRoute(path: string): Route {
  const index = path.indexOf("?");
  const pathname = index === -1 ? path : path.slice(0, index);
  const search = index === -1 ? "" : path.slice(index);
  if (pathname === "/") return { name: "home" };
  // URLSearchParams decodes the value and reads "+" as a space.
  if (pathname === "/search") return { name: "search", query: new URLSearchParams(search).get("q") ?? "" };
  if (pathname === "/users") return { name: "users" };
  if (pathname === "/archive") return { name: "archive" };
  const subroute = matchPageSubroute(pathname);
  if (subroute) return subroute;
  const trash = TRASH_PATTERN.exec(pathname);
  if (trash) {
    const [, id] = trash;
    return id !== undefined && isValidId(id) ? { name: "trash", id } : { name: "notFound" };
  }
  const pageNew = PAGE_NEW_PATTERN.exec(pathname);
  if (pageNew) {
    const [, spaceId] = pageNew;
    if (spaceId === undefined || !isValidId(spaceId)) return { name: "notFound" };
    // A missing, empty or invalid folder is not an error; the page is created at the top level.
    const folder = new URLSearchParams(search).get("folder");
    return { name: "pageNew", spaceId, folderId: folder !== null && isValidId(folder) ? folder : null };
  }
  const match = ROUTE_PATTERN.exec(pathname);
  if (!match) return { name: "notFound" };
  const [, kind, id] = match;
  if (id === undefined || !isValidId(id)) return { name: "notFound" };
  switch (kind) {
    case "spaces":
      return { name: "space", id };
    case "folders":
      return { name: "folder", id };
    default:
      return { name: "page", id };
  }
}

// Notified by navigate(); popstate covers the back and forward buttons.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

// Includes the search part, so that moving from /search?q=a to /search?q=b renders again.
function getPath(): string {
  return location.pathname + location.search;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath);
}

// Asked before navigate() moves to another path; returning false cancels the move. Set by screens with
// unsaved changes. The back and forward buttons (popstate) cannot be stopped and do not ask it.
export type NavigationGuard = () => boolean;

let navigationGuard: NavigationGuard | null = null;

// Sets the guard, replacing the current one; null removes it. Returns a function that removes the guard
// only if it is still the one set here, so that a screen does not remove the guard of the next screen.
export function setNavigationGuard(guard: NavigationGuard | null): () => void {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = null;
  };
}

// Whether navigate() goes on from currentPath to nextPath. The guard is only asked when the path changes.
export function shouldNavigate(currentPath: string, nextPath: string, guard: NavigationGuard | null): boolean {
  if (nextPath === currentPath) return true;
  return guard === null || guard();
}

// Moves to a path inside the SPA. The scroll position is not restored on back; that is left to the browser.
export function navigate(path: string): void {
  const current = getPath();
  if (!shouldNavigate(current, path, navigationGuard)) return;
  if (path !== current) {
    history.pushState(null, "", path);
    for (const listener of listeners) listener();
  }
  window.scrollTo(0, 0);
}

export type ClickEvent = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// Whether a click on a link is handled by the SPA. Other clicks (new tab, new window, download, a
// target attribute) are left to the browser.
export function shouldHandleClick(event: ClickEvent, target?: string): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    target === undefined
  );
}
