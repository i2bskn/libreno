// The part of the CSS of a printed document that depends on the form: the confidentiality label in the top right of
// every page, and the cover page without the margin boxes. The rest is client/public/print-document.css.
// The same string goes into the preview (as a constructed style sheet, which the CSP allows) and into the HTML sent
// to the server (in a <style> element), so that both look the same.

// A CSS string literal of value. The characters that could end the string or the declaration (\ and "), end a
// <style> element (< and >), and line breaks and other control characters are written as hex escapes. The space after
// each escape ends it, so that a hex digit that follows is not read as part of it.
export function cssString(value: string): string {
  const escaped = value.replace(/[\\"<>\u0000-\u001f\u007f-\u009f]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);
  return `"${escaped}"`;
}

// confidentiality is shown only when it has text other than spaces. hasCover hides the page number and the label on
// the first page, which is the cover; it still counts in the total number of pages.
export function buildDynamicCss({ confidentiality, hasCover }: { confidentiality: string; hasCover: boolean }): string {
  const rules: string[] = [];
  const label = confidentiality.trim();
  if (label !== "") rules.push(`@page { @top-right { content: ${cssString(label)}; } }`);
  if (hasCover) rules.push("@page :first { @top-right { content: none; } @bottom-center { content: none; } }");
  return rules.join("\n");
}
