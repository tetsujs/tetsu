/**
 * Kysely on Bun.SQL, for the database a generated file describes, with
 * values that are what its types say.
 *
 * @module
 */

import type { SQL } from "bun";
import { Kysely } from "kysely";
import { ArraysPlugin } from "./arrays.ts";
import { clientOf } from "./client.ts";
import { BunDialect } from "./driver.ts";
import type { Schema } from "./schema.ts";

/**
 * The pool `database()` opens: Bun's options of a Postgres client, but for
 * the address, which the URL is, and those the package sets itself,
 * `bigint` and `adapter`.
 */
export interface DatabaseOptions
  extends Omit<
    SQL.PostgresOrMySQLOptions,
    | "url"
    | "host"
    | "hostname"
    | "port"
    | "username"
    | "user"
    | "database"
    | "db"
    | "adapter"
    | "bigint"
    | "allowPublicKeyRetrieval"
  > {
  /**
   * A `postgres://` URL of the database: the server, the user and the
   * database it names are the ones used. The database is given apart from
   * the URL as well, since Bun 1.4.3 would take `PGDATABASE` over it.
   */
  readonly url: string;
}

/**
 * Kysely on Bun.SQL, for the database the generated `schema` describes.
 *
 * The client is the package's own, so that values are what the types say:
 * `int8` is read as a `bigint`, an `int4[]` or a `float4[]` as an array
 * with parameters and without, a `Date` is written to any timestamp and to
 * a `date`, and a JavaScript array to a column of arrays, which Bun cannot
 * bind: an array of arrays as one of more dimensions, as Bun reads one, and
 * an array of json as the JSON of its elements. An array goes in as the
 * literal Postgres reads where a query says it goes to such a column: a
 * value of an insert, an upsert or a merge, a `set`, a value compared with
 * such a column of the same query, and the argument of `any()` or `all()`.
 * In raw SQL, or as the argument of another function, it is bound as Bun
 * binds it, which fails for an array type: write
 * `` sql`array[${sql.join(items)}]` `` there.
 *
 * Two values Bun reads with parameters stay as it reads them: an `int4[]`
 * or a `float4[]` that holds a NULL cannot be read at all
 * (oven-sh/bun#45062), and a `float4` is read as its 32-bit value, such as
 * `1.100000023841858` for `1.1`.
 *
 * A transaction whose commit Postgres turns into a rollback, as it does
 * when a query of the transaction failed and the failure was caught, fails
 * with Bun's `ERR_POSTGRES_COMMIT_ROLLED_BACK` rather than resolve with
 * nothing written. A query can be cancelled by its `signal`, with the
 * strategy `"cancel query"`; `"kill session"` is not supported, as Bun's
 * pool may wait forever to close a connection the server ended.
 *
 * `db.destroy()` closes the pool, and the connection that cancels.
 *
 * ```ts
 * import { database } from "@tetsujs/sql";
 * import { schema } from "./db.generated.ts";
 *
 * export const db = database(schema, { url: config.DATABASE_URL });
 *
 * await db
 *   .insertInto("orders")
 *   .values({ tags: ["gift"], placed_on: new Date() })
 *   .execute();
 * ```
 *
 * @throws {TypeError} when `url` is not a `postgres://` or
 * `postgresql://` URL.
 * @throws {Error} on a Bun older than 1.4.3, before which a query could be
 * handed the rows of another after a failure.
 */
export function database<DB>(
  schema: Schema<DB>,
  options: DatabaseOptions,
): Kysely<DB> {
  checkBun(Bun.version);

  const protocol = URL.parse(options.url)?.protocol;

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new TypeError(
      "database runs on Postgres: url must be a postgres:// or postgresql:// URL",
    );
  }

  const { url, ...pool } = options;
  const client = { ...pool, adapter: "postgres", bigint: true } as const;

  return new Kysely<DB>({
    dialect: new BunDialect(
      clientOf(url, client),
      clientOf(url, { ...client, max: 1 }),
    ),
    plugins: [new ArraysPlugin(schema.arrays)],
  });
}

/**
 * Refuses a version of Bun older than 1.4.3. Only its numbers count, so a
 * canary build is taken as the release it leads to.
 */
export function checkBun(version: string): void {
  const [major = 0, minor = 0, patch = 0] = (
    /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1) ?? []
  ).map(Number);

  if (
    !(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 3))))
  ) {
    throw new Error(
      `@tetsujs/sql needs Bun 1.4.3 or later, and this is Bun ${version}`,
    );
  }
}
