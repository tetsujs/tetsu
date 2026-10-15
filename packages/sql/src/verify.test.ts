/**
 * `verifySchema()` against a real Postgres: a database up to the types, or
 * newer, passes; one behind them, without a journal, or that applied
 * another text of their migration, is refused saying so.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { testDatabase } from "../test-utils/database.ts";
import { database } from "./database.ts";
import { MigrationError } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { checksum } from "./migration-files.ts";
import type { Schema } from "./schema.ts";
import { verifySchema } from "./verify.ts";

const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-verify-"));

let db: Kysely<unknown>;

afterAll(async () => {
  await db.destroy();
  await rm(scratch, { recursive: true, force: true });
});

const { sql: client, url } = testDatabase();

db = database<unknown>(
  { journal: "migrations", migration: null, arrays: {} },
  { url },
);

const first = { name: "20261010120000_first.sql", text: "select 1;" };
const second = { name: "20261011120000_second.sql", text: "select 2;" };

/** A directory of its own holding these migrations. */
async function directory(
  files: readonly { name: string; text: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(scratch, "dir-"));

  for (const file of files) {
    await Bun.write(join(dir, file.name), file.text);
  }

  return dir;
}

/** The schema of types built up to `migration`, with this journal. */
function built(
  journal: string,
  migration: { name: string; text: string } | null,
): Schema<unknown> {
  return {
    journal,
    migration:
      migration === null
        ? null
        : { name: migration.name, checksum: checksum(migration.text) },
    arrays: {},
  };
}

/** What a check failed with, or that it passed. */
function outcome(check: Promise<void>): Promise<unknown> {
  return check.then(
    () => "passed",
    (error: unknown) => error,
  );
}

describe("a database", () => {
  test("that applied the migration of the types passes", async () => {
    await migrate(client, {
      dir: await directory([first, second]),
      table: "journal_current",
    });

    expect(
      await outcome(verifySchema(db, built("journal_current", second))),
    ).toBe("passed");
  });

  test("newer than the types, as after a rollback of the code, passes", async () => {
    await migrate(client, {
      dir: await directory([first, second]),
      table: "journal_newer",
    });

    expect(await outcome(verifySchema(db, built("journal_newer", first)))).toBe(
      "passed",
    );
  });

  test("with a journal in a schema of its own passes", async () => {
    await migrate(client, {
      dir: await directory([first]),
      table: "ops.journal",
    });

    expect(await outcome(verifySchema(db, built("ops.journal", first)))).toBe(
      "passed",
    );
  });

  test("passes whatever it holds when the types were built from no migration", async () => {
    expect(await outcome(verifySchema(db, built("journal_none", null)))).toBe(
      "passed",
    );
  });
});

describe("a database is refused", () => {
  test("behind the types, when it has not applied their migration", async () => {
    await migrate(client, {
      dir: await directory([first]),
      table: "journal_behind",
    });

    const error = await outcome(
      verifySchema(db, built("journal_behind", second)),
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({
      reason: "behind",
      migration: second.name,
      message: `the database has not applied ${second.name}, which the types were built from: run the migrations first`,
    });
  });

  test("behind the types, when it has no journal", async () => {
    const error = await outcome(
      verifySchema(db, built("journal_missing", first)),
    );

    expect(error).toMatchObject({
      reason: "behind",
      migration: first.name,
      message: `no journal journal_missing is on this connection's search_path, so the types' ${first.name} cannot be found applied: run the migrations first, or, if the journal is in a schema the connection does not search, name it as schema.table`,
    });
  });

  test("when it applied another text of the types' migration", async () => {
    await migrate(client, {
      dir: await directory([first]),
      table: "journal_changed",
    });

    const error = await outcome(
      verifySchema(
        db,
        built("journal_changed", { ...first, text: "select 3;" }),
      ),
    );

    expect(error).toMatchObject({
      reason: "changed",
      migration: first.name,
      message: `the database applied another text of ${first.name} than the types were built from`,
    });
  });

  test("when the table of the journal's name is no journal", async () => {
    await sql`create table journal_other (id int4)`.execute(db);

    const error = await outcome(
      verifySchema(db, built("journal_other", first)),
    );

    expect(error).toMatchObject({
      reason: "table",
      message:
        "journal_other is not a journal of migrations: it has no name or checksum",
    });
  });

  test("by a name that cannot be a journal's, as a TypeError", async () => {
    const error = await outcome(verifySchema(db, built("Bad Name", first)));

    expect(error).toBeInstanceOf(TypeError);
  });
});
