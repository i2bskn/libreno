import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createDb, type Db } from "@i2bskn/workers-app-core";
import {
  createTestHelpers,
  PASSWORD,
  type RequestOptions as CoreRequestOptions,
  type SessionCookies as CoreSessionCookies,
} from "@i2bskn/workers-app-core/testing";
import * as schema from "../src/db/schema";
import { folders, pages, users, type FolderRow, type PageRow, type UserRow } from "../src/db/schema";
import type { Bindings } from "../src/env";
import { insertPersonalSpaceStatement } from "../src/spaces/queries";
import worker from "../src/index";

export { PASSWORD, TEST_JWT_SECRET, type SetCookie } from "@i2bskn/workers-app-core/testing";

export const ORIGIN = "https://libreno.test";
export const OIDC_ORIGIN = "https://wiki.example.com";

// Login, users and requests through the Worker entry point (OAuthProvider), like production.
const helpers = createTestHelpers({
  worker,
  env,
  createExecutionContext,
  waitOnExecutionContext,
  brandId: "libreno",
  origin: ORIGIN,
});

export const { send, setCookies, sessionCookies, login, d1With, countTable } = helpers;

export type RequestOptions = CoreRequestOptions<Cloudflare.Env>;
export type SessionCookies = CoreSessionCookies<"libreno">;

// With the schema of libreno, for db.query.* in the tests.
export const db = drizzle(env.DB, { schema });
// Without a schema, like the Db of the app: for the src functions that take a Db.
export const appDb = createDb(env.DB);

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM site_settings"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM page_revisions"),
    env.DB.prepare("DELETE FROM pages"),
    // One statement, so the foreign key from parent_id is checked only after all folders are gone.
    env.DB.prepare("DELETE FROM folders"),
    env.DB.prepare("DELETE FROM spaces"),
    env.DB.prepare("DELETE FROM users"),
  ]);
}

// Deletes every object in the R2 bucket of attachments, including keys outside attachments/.
export async function resetAttachments(): Promise<void> {
  for (;;) {
    const listed = await env.ATTACHMENTS.list();
    if (listed.objects.length === 0) return;
    await env.ATTACHMENTS.delete(listed.objects.map((object) => object.key));
  }
}

export const oidcEnv: Partial<Bindings> = {
  AUTH_MODE: "oidc",
  APP_ORIGIN: OIDC_ORIGIN,
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "libreno-client",
  OIDC_CLIENT_SECRET: "client-secret",
  // Everyone the IdP signs in. Tests of the allowlist override it.
  ALLOWED_EMAILS: "*",
};

// A user with their personal space, created in one batch like the userCreatedStatements hook of src/core.ts.
export function createUser(params: {
  email: string;
  role?: "admin" | "member";
  password?: string | null;
  createdAt?: number;
}): Promise<UserRow> {
  return helpers.createUser({
    ...params,
    userCreatedStatements: (d1, id, now) => [insertPersonalSpaceStatement(d1, id, now)],
  });
}

export async function countSpaces(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM spaces").first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countPersonalSpaces(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM spaces WHERE kind = 'personal' AND owner_user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// Inserts a user without a personal space, like one created by code older than the spaces migration.
export async function createUserWithoutSpace(params: {
  email: string;
  role?: "admin" | "member";
  createdAt?: number;
  oidc?: { issuer: string; subject: string };
}): Promise<UserRow> {
  const user = await helpers.createUser({
    email: params.email,
    role: params.role,
    password: params.oidc ? null : PASSWORD,
    createdAt: params.createdAt,
  });
  if (!params.oidc) return user;
  const [linked] = await db
    .update(users)
    .set({ oidcIssuer: params.oidc.issuer, oidcSubject: params.oidc.subject })
    .where(eq(users.id, user.id))
    .returning();
  if (!linked) throw new Error("failed to link the user to OIDC");
  return linked;
}

// Inserts a page directly, bypassing the API and its access checks.
export async function insertPage(params: {
  spaceId: string;
  folderId?: string | null;
  title?: string;
  body?: string;
  createdBy?: string | null;
  at?: number;
  id?: string;
  // Puts the page in the trash.
  deletedAt?: number | null;
  deletedBy?: string | null;
}): Promise<PageRow> {
  const at = params.at ?? Date.now();
  const createdBy = params.createdBy ?? null;
  const [page] = await db
    .insert(pages)
    .values({
      id: params.id ?? crypto.randomUUID(),
      spaceId: params.spaceId,
      folderId: params.folderId ?? null,
      title: params.title ?? "Page",
      body: params.body ?? "",
      version: 1,
      createdBy,
      updatedBy: createdBy,
      createdAt: at,
      updatedAt: at,
      deletedAt: params.deletedAt ?? null,
      deletedBy: params.deletedBy ?? null,
    })
    .returning();
  if (!page) throw new Error("failed to create page");
  return page;
}

export async function countPages(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM pages").first<{ count: number }>();
  return row?.count ?? 0;
}

// Inserts a folder directly, bypassing the API and its access checks.
export async function insertFolder(params: {
  spaceId: string;
  parentId?: string | null;
  name?: string;
  createdBy?: string | null;
  at?: number;
}): Promise<FolderRow> {
  const at = params.at ?? Date.now();
  const createdBy = params.createdBy ?? null;
  const [folder] = await db
    .insert(folders)
    .values({
      id: crypto.randomUUID(),
      spaceId: params.spaceId,
      parentId: params.parentId ?? null,
      name: params.name ?? "Folder",
      createdBy,
      updatedBy: createdBy,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!folder) throw new Error("failed to create folder");
  return folder;
}

export async function countFolders(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first<{ count: number }>();
  return row?.count ?? 0;
}

// A Db (without the schema, like the app's) whose D1 binding runs before() once, right before the first statement matching pattern runs (alone
// or in a batch), as if another request changed the data between the checks of a service and its write.
export function dbChangingBefore(pattern: RegExp, before: () => Promise<unknown>): Db {
  const real = env.DB;
  const wrapped = new WeakMap<object, D1PreparedStatement>();
  let done = false;
  async function runBefore() {
    if (done) return;
    done = true;
    await before();
  }
  const d1 = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!pattern.test(query)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              const wrapper = {
                all: async () => (await runBefore(), bound.all()),
                raw: async () => (await runBefore(), bound.raw()),
                run: async () => (await runBefore(), bound.run()),
                first: async () => (await runBefore(), bound.first()),
              };
              wrapped.set(wrapper, bound);
              return wrapper;
            },
          };
        };
      }
      if (prop === "batch") {
        return async (statements: object[]) => {
          if (statements.some((statement) => wrapped.has(statement))) await runBefore();
          return target.batch(statements.map((statement) => wrapped.get(statement) ?? (statement as D1PreparedStatement)));
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createDb(d1);
}
