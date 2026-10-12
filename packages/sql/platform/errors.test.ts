/**
 * What a broken constraint looks like from Bun.SQL: which fields of
 * `PostgresError` say what broke, and what a transaction can do after it.
 *
 * `isViolation()` reads these fields, and the rest of the package must not
 * read `detail`, which holds the values of the row.
 *
 * @module
 */

import { beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import { testDatabase } from "../test-utils/database.ts";
import { failure } from "./values.ts";

const { sql, url } = testDatabase();

beforeAll(async () => {
  await sql`
    create table people (
      id int primary key,
      email text not null,
      status text not null default 'active',
      constraint people_email_key unique (email),
      constraint people_status_check check (status in ('active', 'disabled'))
    )`;
  await sql`create unique index people_lower_email_key on people (lower(email))`;
  await sql`create table posts (id int primary key, author int references people (id))`;
  await sql`
    create table bookings (
      during int4range,
      constraint bookings_overlap exclude using gist (during with &&)
    )`;
  await sql`
    create table orders (
      id int primary key,
      person int references people (id) on delete restrict
    )`;
  await sql`create domain positive as int4 check (value > 0)`;
  await sql`insert into people (id, email) values (1, 'ada@example.com')`;
  await sql`insert into orders values (1, 1)`;
  await sql`insert into bookings values ('[1,5)')`;
});

/** The error a statement fails with. */
async function refusal(
  statement: Promise<unknown>,
): Promise<SQL.PostgresError> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof SQL.PostgresError) {
      return error;
    }

    throw error;
  }

  throw new Error("the statement did not fail");
}

/** What says which rule broke. */
function rule(error: SQL.PostgresError) {
  const { code, errno, constraint, table, schema } = error;

  return { code, errno, constraint, table, schema };
}

test("a unique violation names its constraint and table, and holds the values in detail", async () => {
  const error = await refusal(
    sql`insert into people (id, email) values (2, 'ada@example.com')`,
  );

  expect(rule(error)).toEqual({
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    constraint: "people_email_key",
    table: "people",
    schema: "public",
  });
  expect(error.detail).toContain("ada@example.com");
});

test("a unique index that is not a constraint is named the same way", async () => {
  const error = await refusal(
    sql`insert into people (id, email) values (2, 'ADA@example.com')`,
  );

  expect(rule(error)).toMatchObject({
    errno: "23505",
    constraint: "people_lower_email_key",
  });
});

test("foreign key, check and exclusion violations name their constraints", async () => {
  const foreign = await refusal(
    sql`insert into posts (id, author) values (1, 999)`,
  );
  const check = await refusal(
    sql`insert into people (id, email, status) values (3, 'b@example.com', 'gone')`,
  );
  const exclusion = await refusal(sql`insert into bookings values ('[3,8)')`);

  expect(rule(foreign)).toMatchObject({
    errno: "23503",
    constraint: "posts_author_fkey",
    table: "posts",
  });
  expect(rule(check)).toMatchObject({
    errno: "23514",
    constraint: "people_status_check",
  });
  expect(rule(exclusion)).toMatchObject({
    errno: "23P01",
    constraint: "bookings_overlap",
  });
});

test("ON DELETE RESTRICT is 23001 from Postgres 18 on and 23503 before, and names its constraint", async () => {
  const [server] =
    await sql`select current_setting('server_version_num')::int as version`;
  const error = await refusal(sql`delete from people where id = 1`);

  expect(rule(error)).toMatchObject({
    errno: server.version >= 180000 ? "23001" : "23503",
    constraint: "orders_person_fkey",
    table: "orders",
  });
});

test("a domain's check names its constraint and no table", async () => {
  const error = await refusal(sql`select (-1)::positive`);

  expect(rule(error)).toMatchObject({
    errno: "23514",
    constraint: "positive_check",
  });
  expect(error.table).toBeUndefined();
});

test("a not-null violation names the column and no constraint", async () => {
  const error = await refusal(
    sql`insert into people (id, email) values (4, ${null})`,
  );

  expect(rule(error)).toMatchObject({ errno: "23502", table: "people" });
  expect(error.constraint).toBeUndefined();
  expect(error.column).toBe("email");
});

test("column is a number when Postgres sends none, still oven-sh/bun#45064", async () => {
  const error = await refusal(
    sql`insert into people (id, email) values (5, 'ada@example.com')`,
  );

  expect(typeof error.column).toBe("number");
});

test("after a violation a transaction refuses everything, and sql.begin() refuses its commit", async () => {
  let next: SQL.PostgresError | undefined;

  const commit = sql.begin(async (tx) => {
    await refusal(
      tx`insert into people (id, email) values (6, 'ada@example.com')`,
    );

    next = await refusal(tx`select 1`);
  });

  expect(await commit.then(() => "committed", failure)).toBe(
    "ERR_POSTGRES_COMMIT_ROLLED_BACK",
  );
  expect(next?.errno).toBe("25P02");
});

test("rolling back to a savepoint lets the transaction go on", async () => {
  const [row] = await sql.begin(async (tx) => {
    await tx`savepoint before_insert`;
    await refusal(
      tx`insert into people (id, email) values (7, 'ada@example.com')`,
    );
    await tx`rollback to savepoint before_insert`;

    return await tx`select count(*)::int as people from people`;
  });

  expect(row.people).toBe(1);
});

test("Kysely passes the error on as Bun's own PostgresError", async () => {
  interface Database {
    readonly people: { readonly id: number; readonly email: string };
  }

  const db = new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: new SQL(url) }),
  });

  try {
    const error = await refusal(
      db
        .insertInto("people")
        .values({ id: 8, email: "ada@example.com" })
        .execute(),
    );

    expect(rule(error)).toMatchObject({
      errno: "23505",
      constraint: "people_email_key",
    });
  } finally {
    await db.destroy();
  }
});
