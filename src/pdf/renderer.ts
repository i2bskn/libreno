import type { PdfRenderer } from "../api/types";

// Decides how the PDF of a page is made. "server" only when PDF_RENDERER is "browser" and the BROWSER binding
// exists; anything else falls back to the print dialog of the browser. An unknown value is not an error, so that
// a typo in the dashboard does not stop the rest of the app.
export function resolvePdfRenderer(env: { PDF_RENDERER?: string; BROWSER?: unknown }): PdfRenderer {
  const value = env.PDF_RENDERER ?? "";
  if (value === "browser") return env.BROWSER ? "server" : "print";
  if (value !== "" && value !== "print") {
    console.warn("unknown PDF_RENDERER; using print", { value });
  }
  return "print";
}
