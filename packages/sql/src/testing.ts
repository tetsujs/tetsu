/**
 * A database of its own for each test file, built from the migrations.
 *
 * Tests of code that talks to Postgres run against a real server: a mock
 * of the driver passes queries the database would refuse. Each test file
 * gets an empty database with the migrations applied, dropped when the
 * file ends, so files neither see nor clean up each other's rows.
 *
 * ```ts
 * import { testDatabase } from "@tetsujs/sql/testing";
 * import { schema } from "../src/db.generated.ts";
 *
 * const { db } = testDatabase(schema, {
 *   url: Bun.env.TEST_DATABASE_URL,
 *   dir: "./migrations",
 * });
 *
 * test("stores an order", async () => {
 *   await db.insertInto("orders").values({ … }).execute();
 * });
 * ```
 *
 * @module
 */

import { afterAll, beforeAll } from "bun:test";
import type { Kysely } from "kysely";
import type { DatabaseOptions } from "./database.ts";
import { database } from "./database.ts";
import { migrateScratch } from "./migrate.ts";
import { readMigrations } from "./migration-files.ts";
import type { Schema } from "./schema.ts";
import type { Scratch } from "./scratch.ts";
import {
  connectOptionsOf,
  createScratch,
  scratchName,
  urlOf,
} from "./scratch.ts";

/**
 * Where a test's database is made, and what it is built from; the rest
 * are the options of `database()`, which `db` is made with, so that tests
 * run on a pool set as the application's. Of those, a password, TLS, a
 * socket's path and how long connecting may take reach the server as the
 * database is made and dropped, too.
 */
export interface TestDatabaseOptions extends Omit<DatabaseOptions, "url"> {
  /**
   * A `postgres://` URL of a database on the server the tests may create
   * databases on: its user needs that right. It is usually read from the
   * environment, so `undefined` is taken, and refused saying so.
   */
  readonly url: string | undefined;

  /** The directory of the migration files, from the working directory. */
  readonly dir: string;
}

/** The database of a test file, or of a `describe`. */
export interface TestDatabase<DB> {
  /**
   * Kysely on it, as `database()` makes it with the options given beside
   * `url` and `dir`. It connects on its first query, which a test makes
   * once the database exists.
   */
  readonly db: Kysely<DB>;

  /** Its URL, for code under test that opens connections of its own. */
  readonly url: string;

  /** Its name: `tetsu_sql_` and a UUIDv7. */
  readonly name: string;
}

/**
 * How long creating the database and running the migrations, or dropping
 * it, may take: before Postgres 15, `create database` waits for a
 * checkpoint.
 */
const HOOK_MS = 60_000;

/** How long closing the pool may take before a connection is taken as kept. */
const CLOSE_MS = 5000;

/**
 * Registers the hooks that make a database for the tests where it is
 * called, and drop it once they have run: at the top level of a file for
 * the file, in a `describe` for that `describe`.
 *
 * `beforeAll` creates the database from `template0` and applies the
 * migrations of `dir`, with the journal `schema` names. It fails when the
 * newest migration is not the one the types of `schema` were built from:
 * tests would be checked against types older or newer than the database.
 * Creating it there rather than when called keeps the two hooks in step:
 * when no test of the scope runs, as with a `-t` filter, Bun runs neither.
 *
 * `afterAll` closes the pool, then drops the database, whoever is still on
 * it, one that was still being created when `beforeAll` ran out of time
 * included. A pool that does not close, as when a test left a transaction
 * open, fails the hook once the database is dropped all the same. A run
 * that was killed, or stopped by `--bail`, which skips `afterAll`, leaves
 * its database behind: the next run on the server drops it once it is an
 * hour old and nobody is on it.
 *
 * Bun runs hooks in the order they were registered: call it before the
 * hooks of your own that fill the database, and leave cleaning it to the
 * drop, since an `afterAll` of your own runs once it is gone.
 *
 * @throws {Error} when `url` is not set.
 * @throws {TypeError} when `url` is not a `postgres://` or
 * `postgresql://` URL.
 */
export function testDatabase<DB>(
  schema: Schema<DB>,
  options: TestDatabaseOptions,
): TestDatabase<DB> {
  const { url: server, dir, ...pool } = options;

  if (server === undefined || server === "") {
    throw new Error(
      "testDatabase needs a Postgres server where the tests may create databases: url is not set",
    );
  }

  const name = scratchName();
  const url = urlOf(server, name);
  const db = database(schema, { ...pool, url });
  let created: Promise<Scratch> | undefined;

  beforeAll(async () => {
    created = createScratch(server, name, connectOptionsOf(pool));

    const scratch = await created;

    await migrateScratch(scratch.sql, { dir, table: schema.journal });
    await checkTypes(schema, dir);
  }, HOOK_MS);

  afterAll(async () => {
    let timer: Timer | undefined;
    const closed = await Promise.race([
      db.destroy().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_MS);
      }),
    ]);

    clearTimeout(timer);

    const scratch = await created?.catch(() => undefined);

    await scratch?.drop();

    if (!closed) {
      throw new Error(
        `a connection to the test database ${name} was not handed back: a test left a transaction open, or a query running`,
      );
    }
  }, HOOK_MS);

  return { db, url, name };
}

/**
 * Refuses types built from another migration than the newest of `dir`,
 * the one the test database was built up to.
 */
async function checkTypes(schema: Schema<unknown>, dir: string): Promise<void> {
  const newest = (await readMigrations(dir)).at(-1);
  const built = schema.migration;

  if (newest?.name === built?.name && newest?.checksum === built?.checksum) {
    return;
  }

  const told =
    built === null
      ? "the types were built from no migration"
      : newest?.name === built.name
        ? `the types were built from another text of ${built.name}`
        : `the types were built from ${built.name}`;
  const holds =
    newest === undefined
      ? `${dir} holds no migration`
      : `the migrations of ${dir} go up to ${newest.name}`;

  throw new Error(`${told}, and ${holds}: run tetsu-sql types:generate`);
}
