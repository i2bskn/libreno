import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import type { SpaceKind } from "../api/types";
import { spaceMembers, spaces, type SpaceRow, type UserRow } from "../db/schema";
import { widensVisibility } from "./visibility";

// role must come from the DB on every request (c.get("user")), not from the access token.
export type SpaceViewer = Pick<UserRow, "id" | "role">;

// The only rule of access to spaces, as a where clause on spaces. Every check of access goes through it (as
// findAccessibleSpace for one space), so that the lists and the single reads never disagree.
// Everyone sees the everyone spaces and their own personal space. Admins also see every admin and members space;
// other users see the members spaces that have them in space_members.
// The rows of space_members count only for members spaces.
export function accessibleSpacesWhere(viewer: SpaceViewer): SQL {
  const conditions = [
    eq(spaces.kind, "everyone"),
    and(eq(spaces.kind, "personal"), eq(spaces.ownerUserId, viewer.id)),
  ];
  if (viewer.role === "admin") {
    conditions.push(eq(spaces.kind, "admin"), eq(spaces.kind, "members"));
  } else {
    // spaces is referred to by its name, so that this works in any query with spaces in FROM.
    conditions.push(
      and(
        eq(spaces.kind, "members"),
        sql`EXISTS (SELECT 1 FROM ${spaceMembers} sm WHERE sm.space_id = ${spaces.id} AND sm.user_id = ${viewer.id})`,
      ),
    );
  }
  const where = or(...conditions);
  if (!where) throw new Error("unreachable: empty space access condition");
  return where;
}

// The space if it exists and the viewer can access it, otherwise undefined. Callers report both cases the same
// way, so that the existence of spaces the viewer cannot access is not revealed.
export function findAccessibleSpace(db: Db, viewer: SpaceViewer, spaceId: string): Promise<SpaceRow | undefined> {
  return db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), accessibleSpacesWhere(viewer)))
    .get();
}

// How the moves of pages and folders between spaces treat a move that lets more people see the content.
// The REST API does not require the acknowledgement (the Web UI warns instead); the MCP tools do.
export type MoveOptions = { requireVisibilityAck: boolean; acknowledged: boolean };

// destName is the display name of the destination space, for the message to the user.
export type VisibilityNotAcknowledged = {
  ok: false;
  error: "visibility_not_acknowledged";
  from: SpaceKind;
  to: SpaceKind;
  destName: string;
};

// Returns the failure if the move from source to dest widens the visibility and needs an acknowledgement
// that was not given, otherwise null. Call it only after the access to both spaces has been checked, so
// that the kind of a space the user cannot access is not revealed.
export function visibilityNotAcknowledged(
  source: Pick<SpaceRow, "id" | "kind">,
  dest: Pick<SpaceRow, "id" | "kind" | "name">,
  options: MoveOptions,
): VisibilityNotAcknowledged | null {
  if (!options.requireVisibilityAck || options.acknowledged) return null;
  if (!widensVisibility(source, dest)) return null;
  // Personal spaces have no name; this is the name the Web UI shows for them.
  const destName = dest.kind === "personal" ? "個人スペース" : (dest.name ?? "");
  return { ok: false, error: "visibility_not_acknowledged", from: source.kind, to: dest.kind, destName };
}
