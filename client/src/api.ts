import { hc } from "hono/client";
import { isApiError, unexpectedResponseMessage, type ApiFetch } from "@i2bskn/workers-app-core/client";
// Type-only: the server code must not end up in the client bundle.
import type { AppType } from "../../src/app";

// The fetch for hc() that refreshes the session, and the error messages, from @i2bskn/workers-app-core.
export {
  LoginRequiredError,
  RefreshFailedError,
  createApiFetch,
  unexpectedResponseMessage,
  type ApiFetch,
  type ApiFetchOptions,
} from "@i2bskn/workers-app-core/client";

export function createApiClient(apiFetch: ApiFetch) {
  return hc<AppType>("/", { fetch: apiFetch });
}

// The message to show for a response that is not ok.
export async function responseErrorMessage(res: { status: number; json(): Promise<unknown> }): Promise<string> {
  return (await responseError(res)).message;
}

// The error code (null when the body is not an API error) and the message to show for a response that is not
// ok, from one read of the body, which can be read only once.
export async function responseError(res: {
  status: number;
  json(): Promise<unknown>;
}): Promise<{ code: string | null; message: string }> {
  try {
    const body: unknown = await res.json();
    if (isApiError(body)) {
      return { code: typeof body.error.code === "string" ? body.error.code : null, message: body.error.message };
    }
  } catch {
    // Not JSON.
  }
  return { code: null, message: unexpectedResponseMessage(res.status) };
}
