import { Hono, type MiddlewareHandler } from "hono";
import type { SearchResult } from "../api/types";
import type { AppEnv } from "../env";
import { apiError } from "@i2bskn/workers-app-core";
import { core } from "../core";
import { searchAccessiblePages } from "../pages/search";
import { invalidSearchQueryMessage, normalizeSearchQuery } from "../pages/validation";
import { toApiSearchHit } from "./api";

const { requireUser } = core.middleware;

type SearchQuery = { q: string; spaceId?: string };

// Validates the query string and passes the result to c.req.valid("query").
// Not validator("query"), which turns repeated keys into arrays; c.req.query() takes the first value.
const searchQuery: MiddlewareHandler<
  AppEnv,
  string,
  { in: { query: { q: string; space_id?: string } }; out: { query: SearchQuery } }
> = async (c, next) => {
  const q = normalizeSearchQuery(c.req.query("q"));
  if (q === null) return apiError(c, 400, "invalid_query", invalidSearchQueryMessage);
  const value: SearchQuery = { q };
  const spaceId = c.req.query("space_id");
  // An empty space_id is the same as none.
  if (spaceId !== undefined && spaceId !== "") value.spaceId = spaceId;
  c.req.addValidatedData("query", value);
  return next();
};

const searchApi = new Hono<AppEnv>().get("/", requireUser, searchQuery, async (c) => {
  const { q, spaceId } = c.req.valid("query");
  const result = await searchAccessiblePages(c.get("db"), c.get("user"), q, spaceId);
  if (!result.ok) return apiError(c, 404, "not_found", "スペースが見つかりません");
  const body: SearchResult = { hits: result.result.hits.map(toApiSearchHit), has_more: result.result.hasMore };
  return c.json(body, 200);
});

export default searchApi;
