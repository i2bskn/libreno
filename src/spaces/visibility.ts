// Imported by the client as a value too, so this file must not import any other server code.
import type { SpaceKind } from "../api/types";

// How many people can see a space of each kind: personal (the owner) < admin (all admins) < members (all admins
// and the chosen users) < everyone.
const VISIBILITY_RANK: Record<SpaceKind, number> = { personal: 0, admin: 1, members: 2, everyone: 3 };

// Whether moving from the space from to the space to lets more people see the content.
// Two spaces of the same kind are not wider, even if they are different spaces, except for two members spaces:
// their members may differ, and the members are not compared (a move between them is always treated as wider).
export function widensVisibility(
  from: { id: string; kind: SpaceKind },
  to: { id: string; kind: SpaceKind },
): boolean {
  if (from.id === to.id) return false;
  if (from.kind === "members" && to.kind === "members") return true;
  return VISIBILITY_RANK[to.kind] > VISIBILITY_RANK[from.kind];
}
