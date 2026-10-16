import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

export function api(fetch?: typeof globalThis.fetch) {
  return createClient<Api>({
    baseUrl: "http://localhost:3000",
    ...(fetch === undefined ? {} : { fetch }),
  });
}
