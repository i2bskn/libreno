import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0011 rebuilds spaces (SQLite cannot alter a CHECK) and adds space_members. Applied here to a D1 of its own
// with data written by the migrations before it, so that the rebuild is checked against existing rows. Only this
// test uses MIGRATION_DB; nothing else is applied to it.

const MIGRATION_0011 = "0011_wet_switch.sql";

async function rows(d1: D1Database, query: string): Promise<Record<string, unknown>[]> {
  return (await d1.prepare(query).all<Record<string, unknown>>()).results;
}

async function failure(statement: Promise<unknown>): Promise<string> {
  return statement.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("migration 0011", () => {
  it("rebuilds spaces without changing the data and adds space_members", async () => {
    const d1 = env.MIGRATION_DB;
    const index = env.TEST_MIGRATIONS.findIndex((m) => m.name === MIGRATION_0011);
    const migration = env.TEST_MIGRATIONS[index];
    expect(index).toBe(11);
    if (!migration) throw new Error(`migration ${MIGRATION_0011} not found`);
    await applyD1Migrations(d1, env.TEST_MIGRATIONS.slice(0, index));

    await d1.batch([
      d1.prepare(
        `INSERT INTO users (id, email, role, created_at, updated_at) VALUES
        ('u-admin', 'admin@example.com', 'admin', 1, 1),
        ('u-member', 'member@example.com', 'member', 2, 2)`,
      ),
      d1.prepare(
        `INSERT INTO spaces (id, kind, name, owner_user_id, sort_order, archived_at, created_at, updated_at) VALUES
        ('s-everyone', 'everyone', 'Everyone', NULL, 0, NULL, 10, 11),
        ('s-admin', 'admin', 'Admins', NULL, -5, 1234, 12, 13),
        ('s-archived', 'everyone', 'Archived', NULL, 7, 99, 14, 15),
        ('s-personal-admin', 'personal', NULL, 'u-admin', 0, NULL, 1, 1),
        ('s-personal-member', 'personal', NULL, 'u-member', 3, NULL, 2, 2)`,
      ),
      d1.prepare(
        `INSERT INTO folders (id, space_id, parent_id, name, created_by, updated_by, created_at, updated_at) VALUES
        ('f-top', 's-everyone', NULL, 'Top', 'u-admin', 'u-admin', 20, 20),
        ('f-child', 's-everyone', 'f-top', 'Child', 'u-member', NULL, 21, 22)`,
      ),
      d1.prepare(
        `INSERT INTO pages (id, space_id, folder_id, title, body, version, created_by, updated_by, created_at, updated_at,
          deleted_at, deleted_by) VALUES
        ('p-1', 's-everyone', 'f-child', 'One', '# One', 2, 'u-admin', 'u-member', 30, 31, NULL, NULL),
        ('p-2', 's-admin', NULL, 'Two', 'two', 1, 'u-admin', 'u-admin', 32, 32, NULL, NULL),
        ('p-trash', 's-personal-member', NULL, 'Trash', '', 1, 'u-member', 'u-member', 33, 33, 34, 'u-member')`,
      ),
      d1.prepare(
        `INSERT INTO page_revisions (id, page_id, version, title, body, created_by, created_at) VALUES
        ('r-1', 'p-1', 1, 'One (old)', 'old', 'u-admin', 30)`,
      ),
      d1.prepare(
        `INSERT INTO attachments (id, page_id, filename, content_type, size, created_by, created_at) VALUES
        ('a-1', 'p-1', 'image.png', 'image/png', 123, 'u-member', 35)`,
      ),
    ]);

    const snapshot = async () => ({
      spaces: await rows(d1, "SELECT * FROM spaces ORDER BY id"),
      folders: await rows(d1, "SELECT * FROM folders ORDER BY id"),
      pages: await rows(d1, "SELECT * FROM pages ORDER BY id"),
      pageRevisions: await rows(d1, "SELECT * FROM page_revisions ORDER BY id"),
      attachments: await rows(d1, "SELECT * FROM attachments ORDER BY id"),
    });
    const before = await snapshot();
    expect(before.spaces).toHaveLength(5);

    await applyD1Migrations(d1, [migration]);

    // The rows are the same, column by column (toEqual compares the keys too, so the columns are the same).
    expect(await snapshot()).toEqual(before);

    // No row points at a missing space or user.
    expect(await rows(d1, "PRAGMA foreign_key_check")).toEqual([]);

    // The foreign keys to the new spaces are in force.
    expect(
      await failure(
        d1
          .prepare(
            `INSERT INTO pages (id, space_id, title, body, version, created_at, updated_at)
            VALUES ('p-x', 's-missing', 'X', '', 1, 1, 1)`,
          )
          .run(),
      ),
    ).toContain("FOREIGN KEY constraint failed");
    expect(await failure(d1.prepare("DELETE FROM spaces WHERE id = 's-everyone'").run())).toContain(
      "FOREIGN KEY constraint failed",
    );

    // The unique indexes and the CHECKs.
    const insertSpace = (id: string, kind: string, name: string | null, owner: string | null) =>
      d1
        .prepare(`INSERT INTO spaces (id, kind, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`)
        .bind(id, kind, name, owner)
        .run();
    expect(await failure(insertSpace("s-dup-name", "admin", "Everyone", null))).toContain("UNIQUE constraint failed");
    expect(await failure(insertSpace("s-dup-owner", "personal", null, "u-member"))).toContain(
      "UNIQUE constraint failed",
    );
    expect(await failure(insertSpace("s-other", "other", "Other", null))).toContain("CHECK constraint failed");
    expect(await failure(insertSpace("s-members-owner", "members", "Owned", "u-member"))).toContain(
      "CHECK constraint failed",
    );
    expect(await failure(insertSpace("s-members", "members", "Members", null))).toBe("");

    // space_members, with its foreign keys and the deletes in cascade from the space and from the user.
    await d1
      .prepare(
        `INSERT INTO space_members (space_id, user_id, created_at) VALUES
        ('s-members', 'u-member', 1), ('s-members', 'u-admin', 1)`,
      )
      .run();
    expect(
      await failure(
        d1.prepare("INSERT INTO space_members (space_id, user_id, created_at) VALUES ('s-missing', 'u-member', 1)").run(),
      ),
    ).toContain("FOREIGN KEY constraint failed");
    expect(
      await failure(
        d1.prepare("INSERT INTO space_members (space_id, user_id, created_at) VALUES ('s-members', 'u-missing', 1)").run(),
      ),
    ).toContain("FOREIGN KEY constraint failed");
    await d1.batch([
      d1.prepare("DELETE FROM pages WHERE id = 'p-trash'"),
      d1.prepare("DELETE FROM spaces WHERE id = 's-personal-member'"),
      d1.prepare("DELETE FROM users WHERE id = 'u-member'"),
    ]);
    expect(await rows(d1, "SELECT space_id, user_id FROM space_members")).toEqual([
      { space_id: "s-members", user_id: "u-admin" },
    ]);
    await d1.prepare("DELETE FROM spaces WHERE id = 's-members'").run();
    expect(await rows(d1, "SELECT * FROM space_members")).toEqual([]);
    expect(await rows(d1, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
