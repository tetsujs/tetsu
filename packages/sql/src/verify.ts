/**
 * Checking, before an application serves, that its database is the one
 * its types were generated from, or newer.
 *
 * @module
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { MigrationError } from "./errors.ts";
import { checkJournal } from "./migrate.ts";
import type { Schema } from "./schema.ts";

/**
 * Checks that the database has applied the migration the types of
 * `schema` were built from, with the text they were built from. Newer
 * migrations may follow it: the code is older than the database after a
 * rollback, and runs on it as before.
 *
 * Run it once before the application serves, so that a deploy whose
 * migrations did not run fails at start rather than on the first query
 * that needs them. The journal is read with `db`'s own connection, so its
 * role needs to read it.
 *
 * @example
 * ```ts
 * const db = database(schema, { url: config.DATABASE_URL });
 *
 * await verifySchema(db, schema);
 * Bun.serve({ ...app });
 * ```
 *
 * @throws {MigrationError} with `behind` when the database has not applied
 * the migration, or has no journal; with `changed` when it applied another
 * text of it; with `table` when the journal's table is not a journal.
 * @throws {TypeError} when the schema's journal cannot name one.
 */
export async function verifySchema<DB>(
  db: Kysely<DB>,
  schema: Schema<DB>,
): Promise<void> {
  const { journal, migration } = schema;

  checkJournal(journal);

  if (migration === null) {
    return;
  }

  const [found] = (
    await sql<{
      exists: boolean;
    }>`select to_regclass(${journal}) is not null as exists`.execute(db)
  ).rows;

  if (found?.exists !== true) {
    throw new MigrationError(
      "behind",
      `no journal ${journal} is on this connection's search_path, so the types' ${migration.name} cannot be found applied: run the migrations first, or, if the journal is in a schema the connection does not search, name it as schema.table`,
      { migration: migration.name },
    );
  }

  const applied = await sql<{
    checksum: unknown;
  }>`select checksum from ${sql.id(...journal.split("."))} where name = ${migration.name}`
    .execute(db)
    .catch((error: unknown) => {
      if ((error as { errno?: unknown }).errno === "42703") {
        throw new MigrationError(
          "table",
          `${journal} is not a journal of migrations: it has no name or checksum`,
          { cause: error },
        );
      }

      throw error;
    });
  const [row] = applied.rows;

  if (row === undefined) {
    throw new MigrationError(
      "behind",
      `the database has not applied ${migration.name}, which the types were built from: run the migrations first`,
      { migration: migration.name },
    );
  }

  if (row.checksum !== migration.checksum) {
    throw new MigrationError(
      "changed",
      `the database applied another text of ${migration.name} than the types were built from`,
      { migration: migration.name },
    );
  }
}
