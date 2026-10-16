import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

export function api(fetch?: typeof globalThis.fetch) {
  return createClient<Api, { headers: "authorization" }>({
    baseUrl: "http://localhost:3000",
    headers: () => ({ authorization: "Bearer token" }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
