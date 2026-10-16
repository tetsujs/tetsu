/**
 * The test database helper: what each file gets, that it is gone once the
 * file ends however its tests went, and that it says what it needs.
 *
 * @module
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { testDatabase } from "./database.ts";

const first = testDatabase();
const second = testDatabase();

const helper = JSON.stringify(join(import.meta.dir, "database.ts"));

/**
 * How long a test that runs a fixture in a child `bun test` may take: the
 * child starts Bun and talks to the server, and under load that is slow.
 */
const CHILD_RUN_MS = 20_000;

/**
 * How long the child itself may run before it is killed: less than
 * {@link CHILD_RUN_MS}, so that a child that does not end fails the test
 * with what it printed, rather than with the test's timeout alone.
 */
const FIXTURE_MS = 15_000;

/** Whether a database of that name is on the server. */
async function exists(name: string): Promise<boolean> {
  const admin = new SQL(Bun.env.DATABASE_URL ?? "");

  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;

    return rows.length > 0;
  } finally {
    await admin.close();
  }
}

/**
 * Runs a fixture in a child `bun test` and returns the name of the
 * database it printed, with how the run ended.
 */
function runFixture(
  file: string,
  ...flags: string[]
): { name: string; exitCode: number } {
  const run = Bun.spawnSync(
    [
      "bun",
      "test",
      join(import.meta.dir, "fixtures", file),
      "--path-ignore-patterns=**/node_modules/**",
      ...flags,
    ],
    { env: Bun.env, stdout: "pipe", stderr: "pipe", timeout: FIXTURE_MS },
  );
  const output = `${run.stdout.toString()}${run.stderr.toString()}`;

  if (run.exitCode === null) {
    throw new Error(
      `the fixture did not end within ${FIXTURE_MS} ms (${run.signalCode}):\n${output}`,
    );
  }

  const name = /database: (tetsu_sql_test_[0-9a-f]{32})/.exec(output)?.[1];

  if (name === undefined) {
    throw new Error(`the fixture printed no database name:\n${output}`);
  }

  return { name, exitCode: run.exitCode };
}

/** Calls the helper in a child `bun` with that environment, outside the test runner. */
function callOutsideRunner(
  env: Record<string, string | undefined>,
  uuid = Bun.randomUUIDv7(),
): { stderr: string; exitCode: number } {
  const run = Bun.spawnSync(
    [
      "bun",
      "-e",
      `Bun.randomUUIDv7 = () => ${JSON.stringify(uuid)};
       const { testDatabase } = await import(${helper});
       await testDatabase();`,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  return { stderr: run.stderr.toString(), exitCode: run.exitCode };
}

test("each call creates an empty database of its own", async () => {
  expect(first.name).toMatch(/^tetsu_sql_test_[0-9a-f]{32}$/);
  expect(second.name).not.toBe(first.name);
  expect(await exists(first.name)).toBe(true);
  expect(await exists(second.name)).toBe(true);

  const [empty] = await first.sql`
    select count(*)::int as tables from pg_tables where schemaname = 'public'`;

  expect(empty.tables).toBe(0);

  await first.sql`create table notes (text text)`;

  const [other] = await second.sql`
    select count(*)::int as tables from pg_tables where tablename = 'notes'`;

  expect(other.tables).toBe(0);
});

test("the url reaches the same database as the client", async () => {
  const client = new SQL(first.url);

  try {
    const [row] = await client`select current_database() as name`;

    expect(row.name).toBe(first.name);
  } finally {
    await client.close();
  }
});

test(
  "the database is dropped once its file ends",
  async () => {
    const { name, exitCode } = runFixture("lifetime.ts");

    expect(exitCode).toBe(0);
    expect(await exists(name)).toBe(false);
  },
  CHILD_RUN_MS,
);

test(
  "no database is left when no test of the file runs",
  async () => {
    const { name } = runFixture("lifetime.ts", "-t", "matches no test");

    expect(await exists(name)).toBe(false);
  },
  CHILD_RUN_MS,
);

test(
  "a query a timed-out test left running does not keep its database",
  async () => {
    const { name, exitCode } = runFixture("hang.ts");

    expect(exitCode).not.toBe(0);
    expect(await exists(name)).toBe(false);
  },
  CHILD_RUN_MS,
);

test("outside the test runner it throws before creating a database", async () => {
  const uuid = Bun.randomUUIDv7();
  const run = callOutsideRunner(Bun.env, uuid);

  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain("outside of the test runner");
  expect(await exists(`tetsu_sql_test_${uuid.replaceAll("-", "")}`)).toBe(
    false,
  );
});

test("without DATABASE_URL it fails, saying what it needs", () => {
  const { DATABASE_URL: _, ...unset } = Bun.env;

  for (const env of [unset, { ...unset, DATABASE_URL: "" }]) {
    const run = callOutsideRunner(env);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(
      "the tests of @tetsujs/sql need Postgres: set DATABASE_URL",
    );
  }
});
