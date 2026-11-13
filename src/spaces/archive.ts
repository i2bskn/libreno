import { and, eq, isNotNull, isNull, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { clock, type Db } from "@i2bskn/workers-app-core";
import { spaces, type SpaceRow } from "../db/schema";
import { findAccessibleSpace, type SpaceViewer } from "./access";
import { findSpaceById } from "./queries";

// Archived spaces keep their contents read only: every write to their pages, folders, attachments and
// trash is rejected with space_archived. Reads and the access rules do not change.
// Shared by the REST API and the MCP tools.

export const spaceArchivedMessage =
  "アーカイブされたスペースは編集できません。アーカイブを解除してから操作してください";

// The condition of a write that the space is not archived at the time of the write, so that a space archived
// after the checks of the service changes nothing. spaceId is a bound ID or a column such as pages.space_id.
export function spaceNotArchived(spaceId: string | SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${spaces} sa WHERE sa.id = ${spaceId} AND sa.archived_at IS NULL)`;
}

// Whether the space is archived now. Used to tell why a conditional write changed no rows; a space that no
// longer exists is not archived.
export async function isSpaceArchived(db: Db, spaceId: string): Promise<boolean> {
  const space = await findSpaceById(db, spaceId);
  return space !== undefined && space.archivedAt !== null;
}

export type SetSpaceArchivedResult =
  | { ok: true; space: SpaceRow }
  | { ok: false; error: "not_found" | "forbidden_personal" };

// Archives the space (archived true) or unarchives it. Admins only; the caller checks the role.
// Idempotent: a space already in the requested state is returned as it is, without updating updated_at.
// Personal spaces cannot be archived.
export async function setSpaceArchived(
  db: Db,
  viewer: SpaceViewer,
  spaceId: string,
  archived: boolean,
): Promise<SetSpaceArchivedResult> {
  const space = await findAccessibleSpace(db, viewer, spaceId);
  // Spaces the viewer cannot access are reported as missing so that their existence is not revealed.
  if (!space) return { ok: false, error: "not_found" };
  // Only the owner can see a personal space here, so there is nothing to hide: forbidden rather than not_found.
  if (space.kind === "personal") return { ok: false, error: "forbidden_personal" };
  if ((space.archivedAt !== null) === archived) return { ok: true, space };

  const now = clock.now();
  // One conditional statement, so that of two concurrent requests only one changes the space.
  const updated = await db
    .update(spaces)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(
      and(
        eq(spaces.id, space.id),
        ne(spaces.kind, "personal"),
        archived ? isNull(spaces.archivedAt) : isNotNull(spaces.archivedAt),
      ),
    )
    .returning()
    .get();
  if (updated) return { ok: true, space: updated };
  // Deleted, or put in the requested state by another request, after the check above.
  const current = await findSpaceById(db, space.id);
  if (!current) return { ok: false, error: "not_found" };
  return { ok: true, space: current };
}
