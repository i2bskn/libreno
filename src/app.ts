import { Hono } from "hono";
import { apiError, describeError, isJsonPath } from "@i2bskn/workers-app-core";
import { core } from "./core";
import type { AppEnv } from "./env";
import attachmentsApi from "./routes/attachments";
import foldersApi from "./routes/folders";
import pagesApi from "./routes/pages";
import searchApi from "./routes/search";
import spacesApi from "./routes/spaces";
import topPageApi from "./routes/top-page";

const { loadConfigMiddleware, sameOrigin, securityHeaders, unifyHost } = core.middleware;

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", loadConfigMiddleware);
app.use("*", unifyHost);
// Cookie-authenticated routes only. /mcp and the OAuth endpoints served by OAuthProvider must not use sameOrigin.
app.use("/auth/*", sameOrigin);
app.use("/api/v1/*", sameOrigin);
app.use("/authorize", sameOrigin);

// "/" and other paths not listed in run_worker_first in wrangler.jsonc are served by the static
// assets (the SPA) and never reach the Worker. When adding a top-level path here, add it to
// run_worker_first as well.
app.route("/auth", core.routes.auth);
app.route("/authorize", core.routes.authorize);
const apiRoutes = app
  .route("/api/v1/me", core.routes.me)
  .route("/api/v1/users", core.routes.users)
  .route("/api/v1/spaces", spacesApi)
  .route("/api/v1/pages", pagesApi)
  .route("/api/v1/folders", foldersApi)
  .route("/api/v1/attachments", attachmentsApi)
  .route("/api/v1/search", searchApi)
  .route("/api/v1/top-page", topPageApi);

// Types for hc<AppType>(). Only /api/v1/* is included.
export type AppType = typeof apiRoutes;

app.notFound((c) => {
  if (isJsonPath(c.req.path)) return apiError(c, 404, "not_found", "見つかりません");
  return c.html(core.ErrorPage({ message: "ページが見つかりません" }), 404);
});

app.onError((error, c) => {
  console.error("unhandled error", describeError(error));
  if (isJsonPath(c.req.path)) return apiError(c, 500, "internal_error", "サーバーでエラーが発生しました");
  return c.html(core.ErrorPage({ message: "サーバーでエラーが発生しました" }), 500);
});

export default app;
