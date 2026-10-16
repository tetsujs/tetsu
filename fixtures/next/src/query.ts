import { queryUtils } from "@tetsujs/client/tanstack";
import { api } from "./api";

/** The options of every route, for a client component: the browser sends the cookies. */
export const q = queryUtils(api());

/** The same options on the server, with the cookies of the request it renders. */
export function serverQueries(cookie: string) {
  return queryUtils(api(cookie));
}
