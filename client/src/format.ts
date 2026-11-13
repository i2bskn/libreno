import type { CreateSpaceRequest, Space, SpaceKind } from "../../src/api/types";
// A value import from the server code: visibility.ts imports nothing else, so no other server code is bundled.
import { widensVisibility } from "../../src/spaces/visibility";

export const SPACE_KIND_LABELS: Record<SpaceKind, string> = {
  everyone: "全員",
  admin: "管理者のみ",
  members: "メンバー指定",
  personal: "自分だけ",
};

// Who can see the pages of each kind of space, said in a sentence.
export const SPACE_KIND_DESCRIPTIONS: Record<SpaceKind, string> = {
  everyone: "チームの全員が見られます",
  admin: "管理者だけが見られます",
  members: "選んだメンバーと管理者が見られます",
  personal: "あなただけが見られます",
};

// The kinds of space that can be created from the client; personal spaces are created with their user.
export const CREATABLE_SPACE_KINDS = ["everyone", "admin", "members"] as const satisfies readonly CreateSpaceRequest["kind"][];

export function isCreatableSpaceKind(value: string): value is CreateSpaceRequest["kind"] {
  return (CREATABLE_SPACE_KINDS as readonly string[]).includes(value);
}

// Personal spaces have no name; the client decides how to show them.
export function spaceDisplayName(space: Pick<Space, "kind" | "name">): string {
  return space.kind === "personal" ? "個人スペース" : (space.name ?? "");
}

// The warning shown before moving from the current space (source) to one that more people can see, or to another
// members space, whose members may differ; null if the move does not widen who can see it.
export function widerVisibilityWarning(
  source: Pick<Space, "id" | "kind">,
  dest: Pick<Space, "id" | "kind" | "name">,
): string | null {
  if (!widensVisibility(source, dest)) return null;
  const revisions = "ページの過去の版（履歴）と添付ファイルも見られるようになります。";
  if (source.kind === "members" && dest.kind === "members") {
    return (
      `移動先の「${spaceDisplayName(dest)}」は、今のスペースとは見られる人が違います` +
      `（${SPACE_KIND_LABELS.members} → ${SPACE_KIND_LABELS.members}）。` +
      revisions
    );
  }
  return (
    `移動先の「${spaceDisplayName(dest)}」は、今のスペースより多くの人が見られます` +
    `（${SPACE_KIND_LABELS[source.kind]} → ${SPACE_KIND_LABELS[dest.kind]}）。` +
    revisions
  );
}

// Formats UNIX time in milliseconds. timeZone defaults to the browser's.
export function formatDateTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone }).format(ms);
}

// Shows a body snippet as one line of plain text. It is cut from the body, so "…" is added on both sides.
// Markdown syntax is dropped so that readers see the words: links keep their text, and the marks of headings,
// lists, quotes, emphasis and code go. A link cut at either end of the snippet loses its URL part.
export function formatSnippet(snippet: string): string {
  const text = snippet
    // Links and images whose text and URL are both in the snippet.
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    // A link cut at the start: only the end of its URL remains.
    .replace(/^[^\s()[\]]*\)/, "")
    // A link cut at the end: its URL is not closed.
    .replace(/\]\([^)\s]*$/, "")
    .replace(/[[\]]/g, "")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+])[ \t]+/gm, "")
    .replace(/\*\*|__|`/g, "");
  return `…${text.replace(/\s+/g, " ").trim()}…`;
}

// Splits text into the parts that match query (ignoring case) and the parts between them, for highlighting.
export function splitByQuery(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + q.length), match: true });
    from = at + q.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// How long until a page in the trash is deleted, from purge_after (UNIX time in milliseconds).
// Counted in whole days, rounded up.
export function formatPurgeRemaining(purgeAfter: number, now: number): string {
  const days = Math.ceil((purgeAfter - now) / DAY_MS);
  return days <= 0 ? "まもなく完全に削除されます" : `あと ${days} 日で完全に削除されます`;
}

// A file size in bytes: under 1KB in bytes, under 1MB in KB and otherwise in MB, with one decimal place
// (1KB = 1024 bytes).
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
