import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRINT_DOCUMENT_CSS_PATH } from "./serialize";

// Whether the CSS of the printed document has loaded. Printing waits for it, and stops when it fails.
export type PrintStyleStatus = "loading" | "ready" | "error";

type FrameWindow = Window & typeof globalThis;

// Links must not navigate the iframe: the app inside it is blocked by frame-ancestors 'none' and shows a blank
// frame. Links to a part of the document (footnotes) scroll to it; the others open in a new tab.
function onFrameClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  // Not instanceof: the element belongs to the window of the iframe.
  const link = typeof target?.closest === "function" ? target.closest("a") : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href");
  if (href === null || href === "") return;
  if (href.startsWith("#")) {
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    link.ownerDocument.getElementById(id)?.scrollIntoView();
    return;
  }
  let url: URL;
  try {
    url = new URL(href, location.origin);
  } catch {
    return;
  }
  window.open(url.href, "_blank", "noopener");
}

// An iframe without src (about:blank, same origin) that shows children apart from the CSS of the app: only
// print-document.css and dynamicCss apply inside it, and printing it prints only its contents. The CSP of the app
// (style-src 'self') allows the <link> and the constructed style sheet, but not <style> or style attributes.
export function PrintFrame({
  frameRef,
  title,
  dynamicCss,
  onStyleStatus,
  children,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  title: string;
  dynamicCss: string;
  onStyleStatus: (status: PrintStyleStatus) => void;
  children: ReactNode;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  // The document set up; Firefox may replace the first document of the iframe with another one when it loads.
  const started = useRef<Document | null>(null);
  const titleElement = useRef<HTMLTitleElement | null>(null);
  // The latest callback, so that the listeners added once call the current one.
  const statusCallback = useRef(onStyleStatus);
  statusCallback.current = onStyleStatus;

  function start(): void {
    const frameDoc = frameRef.current?.contentDocument;
    if (!frameDoc || started.current === frameDoc) return;
    started.current = frameDoc;
    statusCallback.current("loading");
    frameDoc.documentElement.lang = "ja";
    const link = frameDoc.createElement("link");
    link.rel = "stylesheet";
    link.href = PRINT_DOCUMENT_CSS_PATH;
    link.addEventListener("load", () => {
      if (started.current === frameDoc) statusCallback.current("ready");
    });
    link.addEventListener("error", () => {
      if (started.current === frameDoc) statusCallback.current("error");
    });
    const titleNode = frameDoc.createElement("title");
    titleElement.current = titleNode;
    frameDoc.head.appendChild(link);
    frameDoc.head.appendChild(titleNode);
    setDoc(frameDoc);
  }

  // Chrome fires load of an iframe without src while it is inserted, before effects run: onLoad catches it.
  // This covers a document that is already complete when the effect runs.
  useEffect(() => {
    if (frameRef.current?.contentDocument?.readyState === "complete") start();
  }, []);

  useEffect(() => {
    if (!doc) return;
    doc.addEventListener("click", onFrameClick);
    return () => doc.removeEventListener("click", onFrameClick);
  }, [doc]);

  useEffect(() => {
    if (titleElement.current) titleElement.current.textContent = title;
  }, [doc, title]);

  // Constructed in the window of the iframe: a sheet made by this window cannot be adopted by its document.
  useEffect(() => {
    const frameWindow = frameRef.current?.contentWindow as FrameWindow | null | undefined;
    if (!doc || !frameWindow) return;
    const sheet = new frameWindow.CSSStyleSheet();
    sheet.replaceSync(dynamicCss);
    doc.adoptedStyleSheets = [sheet];
  }, [doc, dynamicCss]);

  // The iframe is as tall as its contents, so that the page scrolls instead of the frame. Set through the CSSOM:
  // style attributes are blocked by the CSP.
  useEffect(() => {
    const frame = frameRef.current;
    const frameWindow = frame?.contentWindow as FrameWindow | null | undefined;
    if (!doc || !frame || !frameWindow) return;
    const body = doc.body;
    const resize = () => {
      frame.style.height = `${Math.ceil(body.getBoundingClientRect().height)}px`;
    };
    const observer = new frameWindow.ResizeObserver(resize);
    observer.observe(body);
    resize();
    return () => observer.disconnect();
  }, [doc]);

  return (
    <>
      <iframe ref={frameRef} className="pdf-preview-frame" title="PDFのプレビュー" onLoad={start} />
      {doc && createPortal(children, doc.body)}
    </>
  );
}
