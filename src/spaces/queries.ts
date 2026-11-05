import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { spaces, type SpaceRow } from "../db/schema";

// Inserts the user's personal space only if the user exists and has none yet (idempotent).
// Returns a D1 statement because drizzle's D1 batch cannot run db.run(sql) with parameters.
export function insertPersonalSpaceStatement(d1: D1Database, userId: string, now: number): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO spaces (id, kind, name, owner_user_id, created_at, updated_at)
      SELECT ?1, 'personal', NULL, ?2, ?3, ?3
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
        AND NOT EXISTS (SELECT 1 FROM spaces WHERE owner_user_id = ?2)`,
    )
    .bind(crypto.randomUUID(), userId, now);
}

// The order of space lists: personal spaces last, the others by sort_order, then in creation order.
export const spaceListOrder = [
  asc(sql`CASE WHEN ${spaces.kind} = 'personal' THEN 1 ELSE 0 END`),
  asc(spaces.sortOrder),
  asc(spaces.createdAt),
  asc(spaces.id),
];

export function findSpaceById(db: Db, id: string): Promise<SpaceRow | undefined> {
  return db.select().from(spaces).where(eq(spaces.id, id)).get();
}
