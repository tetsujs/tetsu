/**
 * Bun.SQL clients made from a URL, which reach the database it names.
 *
 * @module
 */

import { SQL } from "bun";

/**
 * A client of the database `url` names, with `options` besides: the one in
 * its path, or, with none, the one of its user's name, as Postgres's own
 * clients take it. The name is given apart from the URL as well: Bun 1.4.3
 * takes `PGDATABASE`, when it is set, over the name a URL holds, and would
 * reach another database (oven-sh/bun#45276).
 */
export function clientOf(
  url: string,
  options: Omit<SQL.PostgresOrMySQLOptions, "url"> = {},
): SQL {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1) || parsed.username);

  return new SQL({
    ...options,
    url,
    ...(name === "" ? {} : { database: name }),
  });
}
