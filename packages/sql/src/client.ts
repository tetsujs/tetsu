/**
 * Bun.SQL clients made from a URL, which reach the database it names.
 *
 * @module
 */

import { SQL } from "bun";

/**
 * A client of the database `url` names, with `options` besides. The name is
 * given apart from the URL as well: Bun 1.4.3 takes `PGDATABASE`, when it
 * is set, over the name a URL holds, and would reach another database.
 */
export function clientOf(
  url: string,
  options: Omit<SQL.PostgresOrMySQLOptions, "url"> = {},
): SQL {
  const name = new URL(url).pathname.slice(1);

  return new SQL({
    ...options,
    url,
    ...(name === "" ? {} : { database: decodeURIComponent(name) }),
  });
}
