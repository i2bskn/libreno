import { Hono } from "hono";
import type { SetTopPageRequest, TopPage } from "../api/types";
import type { AppEnv } from "../env";
import { apiError } from "@i2bskn/workers-app-core";
import { core } from "../core";
import { getTopPage, setTopPage } from "../pages/top-page";
import { pageNotFoundMessage } from "../pages/validation";
import { spaceArchivedMessage } from "../spaces/archive";
import { jsonBody, toApiPage } from "./api";

const { requireAdmin, requireUser } = core.middleware;

const setTopPageBody = jsonBody<SetTopPageRequest, SetTopPageRequest, AppEnv>((body, c) => {
  const pageId = body.page_id;
  if (pageId !== null && typeof pageId !== "string") {
    return apiError(c, 400, "invalid_page_id", "page_id は文字列か null にしてください");
  }
  return { ok: true, value: { page_id: pageId } };
});

const topPageApi = new Hono<AppEnv>()
  // Everyone sees the same page: it is shown only while it is in an everyone space and not in the trash.
  .get("/", requireUser, async (c) => {
    const page = await getTopPage(c.get("db"));
    const body: TopPage = { page: page ? toApiPage(page) : null };
    return c.json(body, 200);
  })
  .put("/", requireUser, requireAdmin, setTopPageBody, async (c) => {
    const result = await setTopPage(c.get("db"), c.get("user"), c.req.valid("json").page_id);
    if (result.ok) {
      const body: TopPage = { page: result.page ? toApiPage(result.page) : null };
      return c.json(body, 200);
    }
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    if (result.error === "not_everyone_space") {
      return apiError(c, 400, "not_everyone_space", "トップに表示できるのは全員スペースのページだけです");
    }
    return apiError(c, 404, "not_found", pageNotFoundMessage);
  });

export default topPageApi;
