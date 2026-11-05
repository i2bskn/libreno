import { inArray } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { attachments } from "../db/schema";

// Objects in R2 under attachments/ whose row is gone are deleted by the scheduled job, after
// purgeExpiredTrash. So the objects of pages deleted from the trash after 30 days are deleted in the same
// run, those of pages deleted by an admin in the next daily run, and those left by an upload that stopped
// between R2 and D1 in the first daily run 24 hours after the upload.

const PREFIX = "attachments/";
const KEY = /^attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// Objects uploaded within this time are kept even without a row: the row of an upload in progress is
// written after the object.
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
// The ids checked against D1 per query.
const ID_BATCH = 100;
// R2 deletes up to 1,000 keys per call.
const DELETE_BATCH = 1000;

// Deletes the objects under attachments/ that have no row and were uploaded more than ORPHAN_GRACE_MS
// before now, and returns how many were deleted. Keys that are not attachments/<uuid> are left alone.
// listLimit is the number of objects listed per call (at most 1,000), smaller in tests.
export async function sweepOrphanAttachments(db: Db, bucket: R2Bucket, now: number, listLimit = 1000): Promise<number> {
  const orphans: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix: PREFIX, cursor, limit: listLimit });
    const candidates = new Map<string, string>();
    for (const object of listed.objects) {
      const id = KEY.exec(object.key)?.[1];
      if (id !== undefined && object.uploaded.getTime() < now - ORPHAN_GRACE_MS) candidates.set(id, object.key);
    }
    const ids = [...candidates.keys()];
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const batch = ids.slice(i, i + ID_BATCH);
      const rows = await db.select({ id: attachments.id }).from(attachments).where(inArray(attachments.id, batch)).all();
      const existing = new Set(rows.map((row) => row.id));
      for (const id of batch) {
        const key = candidates.get(id);
        if (key !== undefined && !existing.has(id)) orphans.push(key);
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
    await bucket.delete(orphans.slice(i, i + DELETE_BATCH));
  }
  return orphans.length;
}
