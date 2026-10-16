import { queryUtils } from "@tetsujs/client/tanstack";
import { api } from "./api.ts";

/**
 * The options of every route, over a client with the `fetch` it is given —
 * SvelteKit's, in a `load`, which carries the request's cookies on the
 * server and is replayed in the browser.
 */
export function queries(fetch?: typeof globalThis.fetch) {
  return queryUtils(api(fetch));
}
