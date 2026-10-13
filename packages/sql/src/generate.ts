/**
 * What development and CI need: new migration files, and the types of the
 * database the migrations build.
 *
 * A scratch database is built from the migrations on a real server, its
 * catalog is read, and the result is written as a file of Kysely types —
 * the database the code is written against, as Postgres itself describes
 * it. In CI the same run checks that the file is up to date.
 *
 * ```ts
 * import { createMigration, generate } from "@tetsujs/sql/generate";
 *
 * await createMigration({ dir: "./migrations", name: "add_orders" });
 * await Bun.write(
 *   "src/db.generated.ts",
 *   await generate({ url: Bun.env.DATABASE_URL, dir: "./migrations" }),
 * );
 * ```
 *
 * @module
 */

import { readModel } from "./catalog.ts";
import { checkJournal, migrate, resolveJournal } from "./migrate.ts";
import { readMigrations } from "./migration-files.ts";
import { render } from "./render.ts";
import { createScratch } from "./scratch.ts";

export type { CreateMigrationOptions } from "./migration-files.ts";
export { createMigration } from "./migration-files.ts";

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
}

/**
 * The Kysely types of the database the migrations of `dir` build, as the
 * text of a file: `DB`, the unions of its enums and of the lists its
 * checks allow, `Constraint`, and `schema` for the runtime.
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
 * @throws {TypeError} when `url` is not a `postgres://` or
 * `postgresql://` URL, or `table` cannot name a journal.
 */
export async function generate(options: GenerateOptions): Promise<string> {
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
  const scratch = await createScratch(url);

  try {
    const journal = await resolveJournal(scratch.sql, table);

    await migrate(scratch.sql, { dir: options.dir, table });

    return render(await readModel(scratch.sql, journal.name), {
      journal: table,
      migration:
        newest === undefined
          ? undefined
          : { name: newest.name, checksum: newest.checksum },
    });
  } finally {
    await scratch.drop();
  }
}
