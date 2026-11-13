-- D1 ignores PRAGMA foreign_keys, so the rebuild of spaces below defers the checks to the end of the migration's
-- transaction instead (the procedure in the D1 documentation). Dropping spaces leaves the rows of pages, folders and
-- space_members pointing at a missing table until the new one is renamed to spaces.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `space_members` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_members_user_id_idx` ON `space_members` (`user_id`);--> statement-breakpoint
-- SQLite cannot alter a CHECK, so spaces is rebuilt to add 'members' to spaces_kind_check. The CHECKs name the
-- columns without the table, which the table being created cannot be referred to by.
CREATE TABLE `__new_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`owner_user_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spaces_kind_check" CHECK("kind" IN ('everyone', 'admin', 'members', 'personal')),
	CONSTRAINT "spaces_personal_check" CHECK(("kind" = 'personal') = ("owner_user_id" IS NOT NULL) AND ("kind" = 'personal') = ("name" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_spaces`("id", "kind", "name", "owner_user_id", "sort_order", "archived_at", "created_at", "updated_at") SELECT "id", "kind", "name", "owner_user_id", "sort_order", "archived_at", "created_at", "updated_at" FROM `spaces`;--> statement-breakpoint
DROP TABLE `spaces`;--> statement-breakpoint
ALTER TABLE `__new_spaces` RENAME TO `spaces`;--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_owner_user_id_unique` ON `spaces` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_name_unique` ON `spaces` (`name`);--> statement-breakpoint
PRAGMA defer_foreign_keys = off;
