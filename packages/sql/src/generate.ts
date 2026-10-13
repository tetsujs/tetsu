/**
 * What development and CI need: new migration files, the types of the
 * database the migrations build, and functions of the queries of SQL
 * files, typed by that database.
 *
 * A scratch database is built from the migrations on a real server, its
 * catalog is read, and the result is written as a file of Kysely types —
 * the database the code is written against, as Postgres itself describes
 * it. Each query file is then described by Postgres on the same database,
 * and written as a function of a second file. In CI the same run checks
 * that the files are up to date.
 *
 * ```ts
 * import { createMigration, generate } from "@tetsujs/sql/generate";
 *
 * await createMigration({ dir: "./migrations", name: "add_orders" });
 *
 * const { types, queries } = await generate({
 *   url: Bun.env.DATABASE_URL,
 *   dir: "./migrations",
 *   queries: {
 *     dir: "./queries",
 *     out: "src/queries.generated.ts",
 *     types: "src/db.generated.ts",
 *   },
 * });
 *
 * await Bun.write("src/db.generated.ts", types);
 * await Bun.write("src/queries.generated.ts", queries ?? "");
 * ```
 *
 * @module
 */

import { dirname } from "node:path";
import { readCatalog } from "./catalog.ts";
import { describeQueries } from "./describe.ts";
import { checkJournal, migrate, resolveJournal } from "./migrate.ts";
import { readMigrations } from "./migration-files.ts";
import { readQueryFiles } from "./query-files.ts";
import { render } from "./render.ts";
import { renderQueries } from "./render-queries.ts";
import { createScratch } from "./scratch.ts";
import { Wire } from "./wire.ts";

export type { CreateMigrationOptions } from "./migration-files.ts";
export { createMigration } from "./migration-files.ts";
export { QueryFileError } from "./query-files.ts";

/** The server to build the database on, and the migrations to build it from. */
export interface GenerateOptions {
  /**
   * A `postgres://` URL of a database of the server: the types are built
   * on a scratch database next to it, and it is not touched.
   */
  readonly url: string;

  /** The directory of the migration files, from the working directory. */
  readonly dir: string;

  /** The journal table, as `migrate` is given it. `migrations` by default. */
  readonly table?: string;

  /** The query files to write the functions of, too. */
  readonly queries?: QueriesOptions;
}

/** The query files, and where the files go. */
export interface QueriesOptions {
  /**
   * The directory of the query files, from the working directory: the
   * `.sql` files right in it, one query each.
   */
  readonly dir: string;

  /**
   * Where the file of the functions goes, from the working directory: the
   * paths it holds are relative to it.
   */
  readonly out: string;

  /** Where the file of types goes, which the file of the functions imports. */
  readonly types: string;
}

/** The generated files, as their text. */
export interface GeneratedFiles {
  /** The file of types. */
  readonly types: string;

  /** The file of the queries' functions, when `queries` was given. */
  readonly queries: string | undefined;
}

/**
 * The Kysely types of the database the migrations of `dir` build, as the
 * text of a file: `DB`, the unions of its enums and of the lists its
 * checks allow, `Constraint`, and `schema` for the runtime. With
 * `queries`, the functions of the query files as well, as the text of a
 * second file: each query described by Postgres on that database, without
 * being run, and typed by the first file.
 *
 * The migrations run, by `migrate`, on a scratch database of the server
 * of `url`, which is dropped afterwards, when they fail as well. Its
 * connections are made from `url` as written, with its `sslmode` and its
 * `options`, and its user needs the right to create databases. The
 * database `url` names is not touched, but what a migration does to the
 * whole server — a role it creates, `ALTER SYSTEM` — stays on it: build
 * the types on a server of their own, such as a container, and create
 * roles only where they are missing.
 *
 * Each column is typed as Bun reads it with `bigint: true`, which is how
 * the package's `database()` reads it.
 *
 * @throws {MigrationError} when the migrations do not apply.
 * @throws {QueryFileError} when a query file cannot be read as a query, or
 * Postgres refuses its query: each of them, on a line of the message.
 * @throws {TypeError} when `url` is not a `postgres://` or
 * `postgresql://` URL, or `table` cannot name a journal.
 */
export async function generate(
  options: GenerateOptions,
): Promise<GeneratedFiles> {
  const { url } = options;
  const protocol = URL.parse(url)?.protocol;

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new TypeError(
      "generate runs on Postgres: url must be a postgres:// or postgresql:// URL",
    );
  }

  const table = options.table ?? "migrations";

  checkJournal(table);

  const newest = (await readMigrations(options.dir)).at(-1);
  const files =
    options.queries === undefined
      ? undefined
      : await readQueryFiles(options.queries.dir);
  const scratch = await createScratch(url);

  try {
    const journal = await resolveJournal(scratch.sql, table);

    await migrate(scratch.sql, { dir: options.dir, table });

    const catalog = await readCatalog(scratch.sql, journal.name);
    const types = render(catalog.model, {
      journal: table,
      migration:
        newest === undefined
          ? undefined
          : { name: newest.name, checksum: newest.checksum },
    });

    if (files === undefined || options.queries === undefined) {
      return { types, queries: undefined };
    }

    const wire = await Wire.connect(scratch.sql);

    try {
      return {
        types,
        queries: renderQueries(
          await describeQueries(wire, files, catalog.lookup),
          { base: dirname(options.queries.out), types: options.queries.types },
        ),
      };
    } finally {
      await wire.end();
    }
  } finally {
    await scratch.drop();
  }
}
