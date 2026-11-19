// Makes a PDF from a complete HTML document with the pdf Quick Action of Browser Run.

export type RenderPdfResult =
  | { ok: true; body: ReadableStream }
  // Browser Run answered 429: the limit of the account (shared by every Worker of the account) is reached.
  | { ok: false; error: "limit_exceeded" }
  | { ok: false; error: "failed" };

export async function renderPdf(browser: BrowserRun, html: string): Promise<RenderPdfResult> {
  let res: Response;
  try {
    res = await browser.quickAction("pdf", {
      html,
      // The document is made by the client from a page body, and must not run anything.
      setJavaScriptEnabled: false,
      // Images are inlined as data: URIs by the client; nothing else may be fetched, so that the document cannot
      // reach other sites or internal addresses.
      allowRequestPattern: ["^data:"],
      // "load" waits for the data: images to be decoded.
      gotoOptions: { waitUntil: "load" },
      // The documents may be confidential; Browser Run must not keep them.
      cacheTTL: 0,
      pdfOptions: { format: "a4", printBackground: true, preferCSSPageSize: true, outline: true },
    });
  } catch (error) {
    // Only the message: the error may carry parts of the document.
    console.error("pdf rendering failed", { message: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "failed" };
  }
  if (res.status === 200 && res.body) return { ok: true, body: res.body };
  // The body of an error is not logged: it may quote parts of the document.
  console.error("pdf rendering failed", { status: res.status });
  await res.body?.cancel();
  return { ok: false, error: res.status === 429 ? "limit_exceeded" : "failed" };
}
