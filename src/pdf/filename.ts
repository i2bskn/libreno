// The name of a downloaded PDF, made from the title of the document. Shared by the Worker (the Content-Disposition
// of POST /api/v1/pages/:id/pdf) and the SPA (the download attribute), so that both use the same name.
// This module must not import anything, because the client bundles it.

const MAX_CODE_POINTS = 100;

// Characters that file systems reject (Windows is the strictest), and control characters.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
const EDGES = /^[\s.]+|[\s.]+$/g;
const TRAILING = /[\s.]+$/;

// A Japanese title of 100 characters is about 300 bytes in UTF-8, over the 255-byte limit of most file systems;
// browsers shorten such a name when they save the file.
export function pdfFilename(title: string): string {
  const safe = title.replace(UNSAFE, "_").replace(EDGES, "");
  const cut = Array.from(safe).slice(0, MAX_CODE_POINTS).join("").replace(TRAILING, "");
  return `${cut === "" ? "document" : cut}.pdf`;
}
