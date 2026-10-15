/**
 * Test helper: an empty database of the calling test file's own.
 *
 * The tests of this package run against a real Postgres, the one
 * `DATABASE_URL` names: a server where they may create databases. Each
 * call registers a `beforeAll` that creates a database with a random name
 * and an `afterAll` that drops it, where it is called: at the top level of
 * a file the database lives for the file, in a `describe` for that
 * `describe`. Call it before registering hooks of your own that use it,
 * since Bun runs hooks in the order they were registered, and not inside
 * a hook or a test.
 *
 * Creating in `beforeAll` rather than when called keeps the two in step:
 * when no test of the scope runs, as with a `-t` filter that matches none
 * of them, Bun skips both hooks, and a database created at the call would
 * be left on the server. A run killed or stopped by `--bail` still leaves
 * its databases behind.
 *
 * ```ts
 * const { sql } = testDatabase();
 *
 * beforeAll(async () => {
 *   await sql`create table notes (text text)`;
 * });
 *
 * test("reads what it wrote", async () => {
 *   // ...
 * });
 * ```
 *
 * Importing it takes `PGDATABASE` out of the environment of the run: Bun
 * 1.4.3 takes it over the database a URL names, so the tests' clients
 * would reach a database of the developer's. A test of how the package
 * holds out against it sets it for itself.
 *
 * @module
 */

import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";

delete process.env["PGDATABASE"];

/**
 * How long creating or dropping a database may take, in a hook or a test
 * that does: before Postgres 15, `create database` waits for a checkpoint,
 * and a busy server makes that slow.
 */
export const DATABASE_MS = 20_000;

/**
 * How long closing a client may take once the drop has ended its
 * connections: Bun's `close()` of a client the server cut now and then
 * never settles (oven-sh/bun#42804), and there is nothing left to wait for.
 */
const CLOSE_MS = 1000;

/** A database created for one test file. */
export interface TestDatabase {
  /**
   * Its name: `tetsu_sql_test_` and a UUIDv7 without its dashes, which
   * starts with the time the name was made.
   */
  readonly name: string;

  /** Its URL, for code that opens connections of its own. */
  readonly url: string;

  /**
   * A client of it, which connects on its first query: the database
   * exists from the first `beforeAll` on. Closed once it is dropped.
   */
  readonly sql: SQL;
}

/**
 * Registers the hooks that create an empty database and drop it.
 *
 * The drop comes first and is forced: it ends the client's connections,
 * including one still waiting on a query a timed-out test left running,
 * which closing the client first would wait for until the hook itself
 * timed out. The client is closed after it, and given up on after
 * {@link CLOSE_MS}.
 */
export function testDatabase(): TestDatabase {
  const server = serverUrl();
  const name = `tetsu_sql_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const url = new URL(server);

  url.pathname = `/${name}`;

  const sql = new SQL(url.href);

  beforeAll(async () => {
    await onServer(server, `create database ${name}`);
  }, DATABASE_MS);

  afterAll(async () => {
    try {
      await onServer(server, `drop database if exists ${name} with (force)`);
    } finally {
      await closed(sql);
    }
  }, DATABASE_MS);

  return { name, url: url.href, sql };
}

/** Closes a client, or stops waiting once {@link CLOSE_MS} have passed. */
async function closed(client: SQL): Promise<void> {
  let timer: Timer | undefined;

  await Promise.race([
    client.close(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** Runs one statement on the server's own database, on a client of its own. */
async function onServer(server: string, statement: string): Promise<void> {
  const admin = new SQL(server);

  try {
    await admin.unsafe(statement);
  } finally {
    await admin.close();
  }
}

/**
 * The server the tests may create databases on. Without one they fail
 * saying so, rather than skip: a suite that passes by running nothing
 * looks the same as one that passes.
 */
function serverUrl(): string {
  const { DATABASE_URL: url } = Bun.env;

  if (url === undefined || url === "") {
    throw new Error(
      "the tests of @tetsujs/sql need Postgres: set DATABASE_URL to a server where they may create databases (CONTRIBUTING.md, «Checks», shows how to start one)",
    );
  }

  return url;
}
