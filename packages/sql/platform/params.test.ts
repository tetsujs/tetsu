/**
 * What Bun.SQL does with the values bound to parameters: what reaches the
 * column, and which values it cannot send at all.
 *
 * A case that names an issue pins a Bun bug as it stands: when Bun fixes
 * it, the case fails, and whatever works around it can go. A Postgres
 * array literal written as a string — what the package sends instead of
 * a JavaScript array — is pinned as working.
 *
 * @module
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import { testDatabase } from "../test-utils/database.ts";
import { failure, show } from "./values.ts";

const { url } = testDatabase();
const sql = new SQL(url, { connection: { TimeZone: "UTC" } });

beforeAll(async () => {
  await sql`
    create table writes (
      id serial primary key,
      doc jsonb, i8 int8, ts timestamp, tstz timestamptz, d date, t time,
      ints int4[], floats float4[], texts text[], ids uuid[]
    )`;
});

afterAll(async () => {
  await sql.close();
});

/**
 * Inserts one value into a column and describes what the column then
 * holds, as its text, or the code of the failure.
 */
async function stored(column: string, value: unknown): Promise<string> {
  try {
    const [row] = await sql.unsafe(
      `insert into writes (${column}) values ($1) returning ${column}::text as v`,
      [value],
    );

    return show(row.v);
  } catch (error) {
    return `throws ${failure(error)}`;
  }
}

const date = new Date("2026-10-09T21:30:00Z");
const uuid = "0199d0b2-7a3c-7cc0-9b7e-3f6a1c2d4e5f";

test("an object or an array bound to jsonb is stored as JSON", async () => {
  expect(await stored("doc", { a: 1 })).toBe('string "{\\"a\\": 1}"');
  expect(await stored("doc", [1, 2])).toBe('string "[1, 2]"');
});

test("a string bound to jsonb is stored as a JSON string, so JSON.stringify encodes twice, still oven-sh/bun#28819", async () => {
  expect(await stored("doc", JSON.stringify({ a: 1 }))).toBe(
    'string "\\"{\\\\\\"a\\\\\\":1}\\""',
  );
  expect(await stored("doc", "hello")).toBe('string "\\"hello\\""');
});

test("a number or a boolean bound to jsonb fails", async () => {
  expect(await stored("doc", 5)).toBe("throws 42804");
  expect(await stored("doc", true)).toBe("throws 42804");
});

test("a bigint or a number bound to int8 is stored exactly", async () => {
  expect(await stored("i8", 9007199254740993n)).toBe(
    'string "9007199254740993"',
  );
  expect(await stored("i8", 5)).toBe('string "5"');
});

test("a Date bound to timestamptz is the same instant, and to timestamp its UTC wall time", async () => {
  expect(await stored("tstz", date)).toBe('string "2026-10-09 21:30:00+00"');
  expect(await stored("ts", date)).toBe('string "2026-10-09 21:30:00"');
});

test("an invalid Date bound to timestamptz is stored as the epoch", async () => {
  expect(await stored("tstz", new Date(Number.NaN))).toBe(
    'string "1970-01-01 00:00:00+00"',
  );
});

test("a Date bound to date fails, as Bun sends Date#toString(), still oven-sh/bun#29010", async () => {
  expect(await stored("d", date)).toMatch(/^throws 22(007|023)$/);
});

test("a Date bound to time fails, still oven-sh/bun#29010", async () => {
  expect(await stored("t", date)).toBe("throws 22008");
});

test("an ISO string is stored by date, but time refuses it", async () => {
  expect(await stored("d", date.toISOString())).toBe('string "2026-10-09"');
  expect(await stored("t", date.toISOString())).toBe("throws 22007");
});

test("a JavaScript array bound to an array column fails, still oven-sh/bun#29551", async () => {
  expect(await stored("ints", [1, 2])).toBe("throws 08P01");
  expect(await stored("texts", ["a", "b"])).toBe("throws 22P02");
  expect(await stored("ids", [uuid])).toBe("throws 22P02");
});

test("a typed array read back from int4[] or float4[] cannot be written back", async () => {
  expect(await stored("ints", new Int32Array([1, 2]))).toBe("throws 08P01");
  expect(await stored("floats", new Float32Array([1.5]))).toBe("throws 42804");
});

test("sql.array() fails as a parameter of sql.unsafe(), still oven-sh/bun#29551", async () => {
  expect(await stored("ints", sql.array([1, 2], "INT"))).toBe("throws 08P01");
});

test("sql.array() without a type binds json[]: int4[] refuses it, text[] stores the quotes, still oven-sh/bun#41242", async () => {
  const insert = sql`insert into writes (ints) values (${sql.array([1, 2])})`;

  expect(await insert.then(() => "stored", failure)).toBe("42804");

  const [row] = await sql`
    insert into writes (texts) values (${sql.array(["a", "b"])})
    returning texts`;

  expect(show(row.texts)).toBe('Array [string "\\"a\\"", string "\\"b\\""]');
});

test("sql.array() stores a null element as the string null, still oven-sh/bun#41242", async () => {
  const [row] = await sql`
    insert into writes (texts) values (${sql.array(["a", null], "TEXT")})
    returning texts::text as v, texts[2] is null as missing`;

  expect(row).toEqual({ v: '{a,"null"}', missing: false });
});

test("a Postgres array literal bound as a string is stored, whatever its elements hold", async () => {
  const texts = ["a,b", 'q"uote', "back\\slash", "", "NULL", null, "{brace}"];
  const literal = `{${texts
    .map((text) =>
      text === null
        ? "NULL"
        : `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;

  expect(await stored("ints", "{1,2}")).toBe('string "{1,2}"');

  const [row] = await sql.unsafe(
    "insert into writes (texts) values ($1) returning texts",
    [literal],
  );

  expect(row.texts).toEqual(texts);
});

test("Kysely binds the same way: an object into jsonb is stored, an array into int4[] fails, still oven-sh/bun#29551", async () => {
  interface Database {
    readonly writes: { readonly doc?: unknown; readonly ints?: number[] };
  }

  const db = new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: new SQL(url) }),
  });

  try {
    const [row] = await db
      .insertInto("writes")
      .values({ doc: { a: 1 } })
      .returning((eb) => eb.cast("doc", "text").as("v"))
      .execute();

    expect(row?.v).toBe('{"a": 1}');

    const array = db
      .insertInto("writes")
      .values({ ints: [1, 2] })
      .execute();

    expect(await array.then(() => "stored", failure)).toBe("08P01");
  } finally {
    await db.destroy();
  }
});
