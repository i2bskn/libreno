import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { spaceMembers, spaces, users, type SpaceRow } from "../db/schema";

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

// The user IDs of the members of the space, in the order they were added.
export async function listSpaceMemberIds(db: Db, spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.createdAt), asc(spaceMembers.userId))
    .all();
  return rows.map((row) => row.userId);
}

// How many of the user IDs exist. The IDs are bound as one JSON array, so that any number of them stays within
// the limit of D1 on bound parameters. Pass IDs without duplicates.
export async function countExistingUsers(db: Db, userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.id} IN (SELECT value FROM json_each(${JSON.stringify(userIds)}))`)
    .all();
  return rows.length;
}

// Removes all the members of the space. A D1 statement, to share a batch with insertSpaceMembersStatement.
export function deleteSpaceMembersStatement(d1: D1Database, spaceId: string): D1PreparedStatement {
  return d1.prepare(`DELETE FROM space_members WHERE space_id = ?1`).bind(spaceId);
}

// Adds the users as members of the space in one statement, whatever their number (D1 limits the queries of a
// request). The IDs are bound as one JSON array. Users deleted since they were checked are skipped, and nothing is
// inserted unless the space exists and is a members space, so that neither case fails on a foreign key.
// Pass IDs without duplicates and not already members.
export function insertSpaceMembersStatement(
  d1: D1Database,
  spaceId: string,
  userIds: string[],
  now: number,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO space_members (space_id, user_id, created_at)
      SELECT ?1, u.id, ?2 FROM users u
      WHERE u.id IN (SELECT value FROM json_each(?3))
        AND EXISTS (SELECT 1 FROM spaces WHERE id = ?1 AND kind = 'members')`,
    )
    .bind(spaceId, now, JSON.stringify(userIds));
}
