import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { users } from "@i2bskn/workers-app-core/schema";

// The tables of login and sessions, from @i2bskn/workers-app-core. Re-exported so that drizzle-kit includes them, and
// imported for the references below (a re-export creates no local binding).
export { users, sessions, type UserRow, type SessionRow } from "@i2bskn/workers-app-core/schema";

// Pages belong to one space, and access is decided by the space kind alone.
export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["everyone", "admin", "personal"] }).notNull(),
    // NULL only for personal spaces; clients decide their display name.
    name: text("name"),
    // Set only for personal spaces. Not deleted in cascade.
    ownerUserId: text("owner_user_id").references(() => users.id),
    // Display order: smaller comes first. Not used for personal spaces, which always come last.
    sortOrder: integer("sort_order").notNull().default(0),
    // Set while the space is archived. Its contents are read only and it is left out of the usual lists.
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // One personal space per user. NULLs do not conflict.
    uniqueIndex("spaces_owner_user_id_unique").on(t.ownerUserId),
    // Names are unique across everyone and admin spaces, compared exactly.
    uniqueIndex("spaces_name_unique").on(t.name),
    check("spaces_kind_check", sql`${t.kind} IN ('everyone', 'admin', 'personal')`),
    check(
      "spaces_personal_check",
      sql`(${t.kind} = 'personal') = (${t.ownerUserId} IS NOT NULL) AND (${t.kind} = 'personal') = (${t.name} IS NULL)`,
    ),
  ],
);

// Folders organize pages inside one space and carry no permissions of their own.
// No ON DELETE, so a folder that still has folders or pages cannot be deleted.
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    // Not deleted in cascade, so deleting a space never deletes its folders.
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    // NULL for a folder at the top level of the space. Same space as the parent (checked by the app).
    parentId: text("parent_id").references((): AnySQLiteColumn => folders.id),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("folders_space_id_idx").on(t.spaceId), index("folders_parent_id_idx").on(t.parentId)],
);

// The body is Markdown stored as is. version is for optimistic locking and starts at 1.
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    // Not deleted in cascade, so deleting a space never deletes its pages.
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    // NULL for a page at the top level of the space. Same space as the folder (checked by the app).
    folderId: text("folder_id").references(() => folders.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    version: integer("version").notNull(),
    // Pages outlive the users who created or edited them.
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Set while the page is in the trash of its space. Pages in the trash for TRASH_RETENTION_DAYS are
    // deleted by the scheduled job.
    deletedAt: integer("deleted_at"),
    // Not a foreign key: ADD COLUMN cannot add one with ON DELETE, so this may refer to a deleted user.
    deletedBy: text("deleted_by"),
  },
  (t) => [
    index("pages_space_id_updated_at_idx").on(t.spaceId, t.updatedAt),
    index("pages_folder_id_idx").on(t.folderId),
    index("pages_deleted_at_idx").on(t.deletedAt),
  ],
);

// Earlier versions of pages, kept in full. The newest PAGE_REVISION_LIMIT revisions are kept per page.
export const pageRevisions = sqliteTable(
  "page_revisions",
  {
    id: text("id").primaryKey(),
    // Deleted with the page when it is deleted from the trash.
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    // pages.version at the time this was the content.
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // pages.updated_by and pages.updated_at of that version.
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("page_revisions_page_id_version_unique").on(t.pageId, t.version)],
);

// Files attached to pages. The contents are in R2 (the ATTACHMENTS binding) under attachments/{id}; this
// table holds the metadata only. Objects left without a row are deleted by the scheduled job
// (attachments/sweep.ts).
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    // Deleted with the page when it is deleted from the trash.
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    // Normalized, with the extension of content_type (see attachments/validation.ts).
    filename: text("filename").notNull(),
    // Decided by the server from the first bytes of the file.
    contentType: text("content_type", {
      enum: ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"],
    }).notNull(),
    // Bytes.
    size: integer("size").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("attachments_page_id_idx").on(t.pageId)],
);

// Settings of the whole site. One row, id = 1, created when first set.
export const siteSettings = sqliteTable(
  "site_settings",
  {
    id: integer("id").primaryKey(),
    // The page shown at the top of the home screen. Shown only while it is in an everyone space and not in
    // the trash (checked when read).
    topPageId: text("top_page_id").references(() => pages.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("site_settings_singleton_check", sql`${t.id} = 1`)],
);

export type SpaceRow = typeof spaces.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type PageRow = typeof pages.$inferSelect;
export type PageRevisionRow = typeof pageRevisions.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
