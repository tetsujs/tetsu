import { ClientError, createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

/** Retries a server error or a network failure, not a status the client caused. */
export const retry = (count: number, error: Error) =>
  !(error instanceof ClientError && error.status < 500) && count < 3;

export function api(fetch?: typeof globalThis.fetch) {
  return createClient<Api, { headers: "authorization" }>({
    baseUrl: "http://localhost:3000",
    headers: () => ({ authorization: "Bearer token" }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
