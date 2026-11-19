import { eq } from "drizzle-orm";
import { clock, type Db } from "@i2bskn/workers-app-core";
import { siteSettings, type UserRow } from "../db/schema";

// The defaults of the PDF output form, kept in the single row of site_settings with the top page. Every user reads
// them; only admins change them (the route checks it).

const SETTINGS_ID = 1;
const MAX_LENGTH = 100;

export const invalidPdfSettingsMessage = "発行者と機密表示は改行を含まない100文字以内で入力してください";

// Line breaks and the other C0 controls, DEL, the C1 controls, and the bidirectional controls, which could make the
// printed text read differently from what was typed.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export type PdfSettingsRow = { issuer: string | null; confidentiality: string | null };

// Normalizes a value of PUT /api/v1/pdf-settings: a string without forbidden characters (checked before trimming,
// so that a trailing line break is rejected rather than trimmed away), trimmed, empty as null, and at most 100
// code points. undefined (a missing key) and other types are invalid. Returns { ok: false } when invalid.
export function normalizePdfSettingValue(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  if (FORBIDDEN.test(value)) return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (Array.from(trimmed).length > MAX_LENGTH) return { ok: false };
  return { ok: true, value: trimmed };
}

export async function getPdfSettings(db: Db): Promise<PdfSettingsRow> {
  const row = await db
    .select({ issuer: siteSettings.pdfIssuer, confidentiality: siteSettings.pdfConfidentiality })
    .from(siteSettings)
    .where(eq(siteSettings.id, SETTINGS_ID))
    .get();
  return { issuer: row?.issuer ?? null, confidentiality: row?.confidentiality ?? null };
}

// Saves both values, leaving the top page as it is. The caller checks that the user is an admin.
export async function savePdfSettings(db: Db, admin: UserRow, settings: PdfSettingsRow): Promise<PdfSettingsRow> {
  const now = clock.now();
  const values = {
    pdfIssuer: settings.issuer,
    pdfConfidentiality: settings.confidentiality,
    updatedBy: admin.id,
    updatedAt: now,
  };
  const [row] = await db
    .insert(siteSettings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: siteSettings.id, set: values })
    .returning({ issuer: siteSettings.pdfIssuer, confidentiality: siteSettings.pdfConfidentiality });
  if (!row) throw new Error("unreachable: an upsert returns its row");
  return row;
}
