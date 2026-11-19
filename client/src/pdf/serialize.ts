// Turns the printed document shown in the preview into a complete HTML document for POST /api/v1/pages/:id/pdf.
// Browser Run renders it with JavaScript off and without any network access, so everything it needs is put in it:
// the CSS, absolute links, and the images as data: URIs.

export const PRINT_DOCUMENT_CSS_PATH = "/print-document.css";

// The href of a link in the PDF. Links inside the document (footnotes) stay as they are; the others become absolute,
// as the PDF is not read on this site. null when href cannot be parsed: the attribute is removed.
export function absolutizeHref(href: string, origin: string): string | null {
  if (href.startsWith("#")) return href;
  try {
    return new URL(href, origin).href;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Neither CSS may end its <style> element early.
function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

export function buildPdfHtml({
  title,
  css,
  dynamicCss,
  bodyHtml,
}: {
  title: string;
  css: string;
  dynamicCss: string;
  bodyHtml: string;
}): string {
  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>${escapeStyle(css)}</style><style>${escapeStyle(dynamicCss)}</style></head>` +
    `<body>${bodyHtml}</body></html>`
  );
}

function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("no result")));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

// The image as a data: URI, or null when it is on another site (the server fetches nothing) or cannot be read.
async function imageDataUri(src: string, origin: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  try {
    const res = await fetch(url.href, { credentials: "same-origin" });
    if (!res.ok) return null;
    return await readAsDataUri(await res.blob());
  } catch {
    return null;
  }
}

// Replaces an image that cannot be put in the PDF with its alt text.
function replaceWithAlt(img: HTMLImageElement): void {
  const span = img.ownerDocument.createElement("span");
  span.textContent = img.getAttribute("alt") ?? "";
  img.replaceWith(span);
}

// The HTML of the printed document (.print-doc) in doc, ready for the server. The document shown is not changed.
export async function serializePrintDocument(doc: Document, origin: string): Promise<string | null> {
  const source = doc.querySelector(".print-doc");
  if (source === null) return null;
  const clone = source.cloneNode(true) as Element;
  for (const button of Array.from(clone.querySelectorAll(".code-copy-button"))) button.remove();
  for (const link of Array.from(clone.querySelectorAll("a[href]"))) {
    const href = absolutizeHref(link.getAttribute("href") ?? "", origin);
    if (href === null) link.removeAttribute("href");
    else link.setAttribute("href", href);
  }
  await Promise.all(
    Array.from(clone.querySelectorAll("img")).map(async (img) => {
      const src = img.getAttribute("src");
      const dataUri = src === null ? null : await imageDataUri(src, origin);
      if (dataUri === null) replaceWithAlt(img);
      else img.setAttribute("src", dataUri);
    }),
  );
  return clone.outerHTML;
}

// The CSS of the printed document. Already in the cache of the browser after the preview has loaded it.
export async function fetchPrintCss(): Promise<string | null> {
  try {
    const res = await fetch(PRINT_DOCUMENT_CSS_PATH, { credentials: "same-origin" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
