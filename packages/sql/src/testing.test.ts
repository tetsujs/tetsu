/**
 * `@tetsujs/sql/testing`: the database a test file gets is built from the
 * migrations, and gone once the file ends — however its tests went, when a
 * `-t` filter skips them, when its types are stale, and when a test keeps
 * a connection. Each case runs a fixture in a child `bun test`.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { schema } from "../test-utils/fixtures/schema/db.generated.ts";
import { testDatabase } from "./testing.ts";

/**
 * How long a test that runs a fixture may take: the child creates a
 * database and runs the migrations, and before Postgres 15 creating one
 * waits for a checkpoint.
 */
const CHILD_RUN_MS = 90_000;

const server = new SQL(Bun.env.DATABASE_URL ?? "");

afterAll(async () => {
  await server.close();
});

/** Whether a database of that name is on the server. */
async function exists(name: string): Promise<boolean> {
  const rows = await server`select 1 from pg_database where datname = ${name}`;

  return rows.length > 0;
}

/**
 * How long a fixture may run before it is stopped: longer than a hook of
 * its own may take, so that a hook that hangs fails in the child, saying
 * so, and less than {@link CHILD_RUN_MS}.
 */
const FIXTURE_MS = 80_000;

/**
 * Runs a fixture in a child `bun test`: the names of the databases it
 * printed, what it printed, and how it ended.
 */
async function runFixture(
  file: string,
  ...flags: string[]
): Promise<{ names: string[]; output: string; exitCode: number }> {
  const child = Bun.spawn(
    [
      "bun",
      "test",
      join(import.meta.dir, "../test-utils/fixtures/testing", file),
      "--path-ignore-patterns=**/node_modules/**",
      ...flags,
    ],
    { env: Bun.env, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), FIXTURE_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  clearTimeout(timer);

  const output = `${stdout}${stderr}`;
  const names = [...output.matchAll(/database: (tetsu_sql_[0-9a-f]{32})/g)].map(
    (match) => match[1] ?? "",
  );

  if (names.length === 0 || child.signalCode !== null) {
    throw new Error(
      `the fixture printed no database name, or was stopped (${String(child.signalCode)}):\n${output}`,
    );
  }

  return { names, output, exitCode };
}

describe("a test file's database", () => {
  test(
    "is built from the migrations, and dropped once the file ends",
    async () => {
      const { names, exitCode, output } = await runFixture("uses.ts");

      expect({ exitCode, output }).toMatchObject({ exitCode: 0 });
      expect(output).toContain("built");
      expect(await exists(names[0] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );

  test(
    "is never made when no test of the file runs",
    async () => {
      const { names, output } = await runFixture(
        "uses.ts",
        "-t",
        "matches no test",
      );

      expect(output).not.toContain("built");
      expect(await exists(names[0] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );

  test(
    "is refused when the types were built from another migration, and dropped all the same",
    async () => {
      const { names, exitCode, output } = await runFixture("stale.ts");

      expect(exitCode).toBe(1);
      expect(output).toContain(
        "the types were built from 20261001120000_kinds.sql, and the migrations of",
      );
      expect(output).toContain(
        "go up to 20261003120000_orders.sql: run tetsu-sql types:generate",
      );
      expect(await exists(names[0] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );

  test(
    "fails the file when its migrations fail, saying nothing of a baseline, and is dropped all the same",
    async () => {
      const { names, exitCode, output } = await runFixture("duplicate.ts");

      expect(exitCode).toBe(1);
      expect(output).toContain(
        '20261010120000_public.sql failed: schema "public" already exists',
      );
      expect(output).not.toContain("baseline");
      expect(await exists(names[0] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );

  test(
    "fails the file when a test keeps a connection, and is dropped all the same",
    async () => {
      const { names, exitCode, output } = await runFixture("leaks.ts");

      expect(exitCode).toBe(1);
      expect(output).toContain(
        `a connection to the test database ${names[0]} was not handed back`,
      );
      expect(await exists(names[0] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );

  test(
    "is one of each describe's own, unseen by the other",
    async () => {
      const { names, exitCode, output } = await runFixture("scopes.ts");

      expect({ exitCode, output }).toMatchObject({ exitCode: 0 });
      expect(names).toHaveLength(2);
      expect(names[0]).not.toBe(names[1]);
      expect(await exists(names[0] ?? "")).toBe(false);
      expect(await exists(names[1] ?? "")).toBe(false);
    },
    CHILD_RUN_MS,
  );
});

describe("a test file's database needs a server", () => {
  test("and says so when its URL is not set", () => {
    expect(() =>
      testDatabase(schema, { url: undefined, dir: "./migrations" }),
    ).toThrow(
      "testDatabase needs a Postgres server where the tests may create databases: url is not set",
    );
  });

  test("of Postgres", () => {
    expect(() =>
      testDatabase(schema, { url: "sqlite://tests.db", dir: "./migrations" }),
    ).toThrow(
      new TypeError(
        "database runs on Postgres: url must be a postgres:// or postgresql:// URL",
      ),
    );
  });
});
