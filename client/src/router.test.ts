import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClickEvent, matchRoute, navigate, setNavigationGuard, shouldHandleClick, shouldNavigate } from "./router";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("matchRoute", () => {
  it("matches the screens", () => {
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/spaces/abc")).toEqual({ name: "space", id: "abc" });
    expect(matchRoute("/pages/abc")).toEqual({ name: "page", id: "abc" });
    expect(matchRoute(`/spaces/${UUID}`)).toEqual({ name: "space", id: UUID });
    expect(matchRoute(`/pages/${UUID}`)).toEqual({ name: "page", id: UUID });
    expect(matchRoute("/folders/abc")).toEqual({ name: "folder", id: "abc" });
    expect(matchRoute(`/folders/${UUID}`)).toEqual({ name: "folder", id: UUID });
  });

  it.each([
    "/pages/..%2F..%2Fusers",
    "/spaces/x%2Fpages",
    "/pages/a%3Fb",
    "/spaces/%E3%81%82",
    "/pages/a.b",
    "/folders/a.b",
    "/folders/..%2Fspaces",
  ])(
    "does not accept the ID in %s",
    (path) => {
      expect(matchRoute(path)).toEqual({ name: "notFound" });
    },
  );

  it("matches the history and revision screens of a page", () => {
    expect(matchRoute("/pages/x/history")).toEqual({ name: "pageHistory", id: "x" });
    expect(matchRoute(`/pages/${UUID}/history`)).toEqual({ name: "pageHistory", id: UUID });
    expect(matchRoute("/pages/x/revisions/3")).toEqual({ name: "pageRevision", id: "x", version: 3 });
    expect(matchRoute("/pages/x/revisions/9007199254740991")).toEqual({
      name: "pageRevision",
      id: "x",
      version: 9007199254740991,
    });
  });

  it.each([
    "/pages/x/revisions/0",
    "/pages/x/revisions/01",
    "/pages/x/revisions/abc",
    "/pages/x/revisions/1.5",
    "/pages/x/revisions/-1",
    "/pages/x/revisions/9007199254740992",
    "/pages/x/revisions/12345678901234567",
    "/pages/x/revisions/",
    "/pages/x/revisions",
    "/pages/x/revisions/3/extra",
    "/pages/x/history/",
    "/pages/x/history/1",
    "/pages/a.b/history",
    "/pages/a.b/revisions/1",
    "/spaces/x/history",
  ])("does not match %s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });

  it("matches the trash screen of a space", () => {
    expect(matchRoute("/spaces/x/trash")).toEqual({ name: "trash", id: "x" });
    expect(matchRoute(`/spaces/${UUID}/trash`)).toEqual({ name: "trash", id: UUID });
  });

  it.each(["/spaces/x/trash/", "/spaces/a.b/trash", "/spaces/x/trash/1", "/pages/x/trash", "/folders/x/trash"])(
    "does not match %s as the trash screen",
    (path) => {
      expect(matchRoute(path)).toEqual({ name: "notFound" });
    },
  );

  it("matches the search screen with its query", () => {
    expect(matchRoute("/search?q=abc")).toEqual({ name: "search", query: "abc" });
    expect(matchRoute("/search")).toEqual({ name: "search", query: "" });
    expect(matchRoute("/search?q=")).toEqual({ name: "search", query: "" });
    expect(matchRoute("/search?q=%E6%A4%9C")).toEqual({ name: "search", query: "検" });
    expect(matchRoute("/search?q=a+b")).toEqual({ name: "search", query: "a b" });
    expect(matchRoute("/search?q=a&q=b")).toEqual({ name: "search", query: "a" });
  });

  it("matches the archive screen exactly", () => {
    expect(matchRoute("/archive")).toEqual({ name: "archive" });
    expect(matchRoute("/archive?a=1")).toEqual({ name: "archive" });
    expect(matchRoute("/archive/")).toEqual({ name: "notFound" });
    expect(matchRoute("/archive/abc")).toEqual({ name: "notFound" });
  });

  it("matches the users screen exactly", () => {
    expect(matchRoute("/users")).toEqual({ name: "users" });
    expect(matchRoute("/users?a=1")).toEqual({ name: "users" });
    expect(matchRoute("/users/")).toEqual({ name: "notFound" });
    expect(matchRoute("/users/abc")).toEqual({ name: "notFound" });
  });

  it("ignores the search part on other screens", () => {
    expect(matchRoute("/spaces/x?a=1")).toEqual({ name: "space", id: "x" });
    expect(matchRoute("/?q=a")).toEqual({ name: "home" });
  });

  it("accepts IDs of up to 64 characters", () => {
    const id64 = "a".repeat(64);
    expect(matchRoute(`/pages/${id64}`)).toEqual({ name: "page", id: id64 });
    expect(matchRoute(`/pages/${"a".repeat(65)}`)).toEqual({ name: "notFound" });
  });

  it.each(["/spaces/", "/spaces/abc/", "/spaces/abc/x", "//spaces/abc", "/pages", "/folders", "/folders/", "/unknown"])(
    "does not match %s",
    (path) => {
      expect(matchRoute(path)).toEqual({ name: "notFound" });
    },
  );
});

describe("matchRoute for the page form", () => {
  it("matches the page creation screen with the folder from the query", () => {
    expect(matchRoute("/spaces/x/new")).toEqual({ name: "pageNew", spaceId: "x", folderId: null });
    expect(matchRoute(`/spaces/${UUID}/new`)).toEqual({ name: "pageNew", spaceId: UUID, folderId: null });
    expect(matchRoute("/spaces/x/new?folder=f1")).toEqual({ name: "pageNew", spaceId: "x", folderId: "f1" });
    expect(matchRoute(`/spaces/x/new?folder=${UUID}`)).toEqual({ name: "pageNew", spaceId: "x", folderId: UUID });
  });

  it.each(["/spaces/x/new?folder=", "/spaces/x/new?folder=a.b", "/spaces/x/new?folder=..%2Fx", "/spaces/x/new?other=f1"])(
    "treats the folder in %s as missing",
    (path) => {
      expect(matchRoute(path)).toEqual({ name: "pageNew", spaceId: "x", folderId: null });
    },
  );

  it("matches the page edit screen", () => {
    expect(matchRoute("/pages/x/edit")).toEqual({ name: "pageEdit", id: "x" });
    expect(matchRoute(`/pages/${UUID}/edit`)).toEqual({ name: "pageEdit", id: UUID });
    expect(matchRoute("/pages/x/edit?a=1")).toEqual({ name: "pageEdit", id: "x" });
  });

  it.each([
    "/spaces/x/new/",
    "/spaces/x/new/1",
    "/spaces/a.b/new",
    "/spaces/a.b/new?folder=f1",
    "/folders/x/new",
    "/pages/x/new",
    "/pages/x/edit/",
    "/pages/x/edit/1",
    "/pages/a.b/edit",
    "/spaces/x/edit",
  ])("does not match %s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });
});

describe("shouldNavigate", () => {
  it("goes on without a guard", () => {
    expect(shouldNavigate("/a", "/b", null)).toBe(true);
  });

  it("asks the guard when the path changes", () => {
    const guard = vi.fn(() => false);
    expect(shouldNavigate("/a", "/b", guard)).toBe(false);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(shouldNavigate("/a", "/b", () => true)).toBe(true);
  });

  it("does not ask the guard for the current path", () => {
    const guard = vi.fn(() => false);
    expect(shouldNavigate("/a?q=1", "/a?q=1", guard)).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("navigate", () => {
  let release: (() => void) | null = null;

  // navigate() reads location and calls history and window, which Node does not have.
  function stubBrowser(path: string) {
    const pushState = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("location", { pathname: path, search: "" });
    vi.stubGlobal("history", { pushState });
    vi.stubGlobal("window", { scrollTo });
    return { pushState, scrollTo };
  }

  afterEach(() => {
    release?.();
    release = null;
    vi.unstubAllGlobals();
  });

  it("moves when there is no guard", () => {
    const { pushState } = stubBrowser("/a");
    navigate("/b");
    expect(pushState).toHaveBeenCalledWith(null, "", "/b");
  });

  it("does not move when the guard returns false", () => {
    const { pushState, scrollTo } = stubBrowser("/a");
    const guard = vi.fn(() => false);
    release = setNavigationGuard(guard);
    navigate("/b");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("moves when the guard returns true", () => {
    const { pushState } = stubBrowser("/a");
    release = setNavigationGuard(() => true);
    navigate("/b");
    expect(pushState).toHaveBeenCalledWith(null, "", "/b");
  });

  it("does not ask the guard for the current path", () => {
    const { pushState, scrollTo } = stubBrowser("/a");
    const guard = vi.fn(() => false);
    release = setNavigationGuard(guard);
    navigate("/a");
    expect(guard).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("removes the guard with the returned function", () => {
    const { pushState } = stubBrowser("/a");
    const remove = setNavigationGuard(() => false);
    remove();
    navigate("/b");
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it("does not remove a guard that replaced the one being removed", () => {
    const { pushState } = stubBrowser("/a");
    const removeFirst = setNavigationGuard(() => false);
    const second = vi.fn(() => false);
    release = setNavigationGuard(second);
    removeFirst();
    navigate("/b");
    expect(second).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
  });
});

describe("shouldHandleClick", () => {
  const click: ClickEvent = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("handles a plain left click", () => {
    expect(shouldHandleClick(click)).toBe(true);
  });

  it("leaves a click whose default is prevented", () => {
    expect(shouldHandleClick({ ...click, defaultPrevented: true })).toBe(false);
  });

  it("leaves a middle click", () => {
    expect(shouldHandleClick({ ...click, button: 1 })).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)("leaves a click with %s", (key) => {
    expect(shouldHandleClick({ ...click, [key]: true })).toBe(false);
  });

  it("leaves a link with a target", () => {
    expect(shouldHandleClick(click, "_blank")).toBe(false);
  });
});
