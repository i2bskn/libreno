// D1 errors may be wrapped (e.g. DrizzleQueryError), so the cause chain is followed.
// Keep in the same shape as isUniqueViolation.
export function isForeignKeyViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("FOREIGN KEY constraint failed")) return true;
  }
  return false;
}

// A UNIQUE violation of the spaces table itself (e.g. "UNIQUE constraint failed: spaces.name"). Used where the INSERT
// of a space shares a batch with other statements, so that a violation in those is not taken for a duplicate name.
export function isSpaceUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed: spaces.")) return true;
  }
  return false;
}
