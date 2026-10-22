/**
 * What Bun.SQL does with the values bound to parameters: what reaches the
 * column, and which values it cannot send at all.
 *
 * A case that names an issue pins a Bun bug as it stands: when Bun fixes
 * it, the case fails, and whatever works around it can go. Bun 1.4.4 binds
 * a `Date` to a `date` and a `time`, and a JavaScript array to an array
 * type, as Postgres reads them; the package still writes a `Date` as its
 * ISO text and an array as its Postgres literal, until a release of its
 * own drops them, so the literal stays pinned as working.
 *
 * @module
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { testDatabase } from "../test-utils/database.ts";
import { failure, show } from "./values.ts";

afterAll(async () => {
  await sql.close();
});

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

test("a number that is not whole bound to int8 is rounded to the even, as Bun binds it as a float8", async () => {
  expect(await stored("i8", 2.5)).toBe('string "2"');
  expect(await stored("i8", 3.5)).toBe('string "4"');
});

test("a string bound to int8 is read as int8, which refuses a fraction", async () => {
  expect(await stored("i8", "42")).toBe('string "42"');
  expect(await stored("i8", "2.5")).toBe("throws 22P02");
});

test("a Date bound to timestamptz is the same instant, and to timestamp its UTC wall time", async () => {
  expect(await stored("tstz", date)).toBe('string "2026-10-09 21:30:00+00"');
  expect(await stored("ts", date)).toBe('string "2026-10-09 21:30:00"');
});

test("an invalid Date bound to timestamptz is refused", async () => {
  expect(await stored("tstz", new Date(Number.NaN))).toBe("throws 22007");
});

test("a Date bound to date is its UTC date, and to time its UTC wall time", async () => {
  expect(await stored("d", date)).toBe('string "2026-10-09"');
  expect(await stored("t", date)).toBe('string "21:30:00"');
});

test("an ISO string is stored by date, but time refuses it", async () => {
  expect(await stored("d", date.toISOString())).toBe('string "2026-10-09"');
  expect(await stored("t", date.toISOString())).toBe("throws 22007");
});

test("a JavaScript array bound to an array column is stored, of more dimensions too", async () => {
  expect(await stored("ints", [1, null])).toBe('string "{1,NULL}"');
  expect(
    await stored("ints", [
      [1, 2],
      [3, 4],
    ]),
  ).toBe('string "{{1,2},{3,4}}"');
  expect(await stored("texts", ["a,b", 'q"uote', "NULL", null])).toBe(
    'string "{\\"a,b\\",\\"q\\\\\\"uote\\",\\"NULL\\",NULL}"',
  );
  expect(await stored("ids", [uuid])).toBe(`string "{${uuid}}"`);
});

test("an Int32Array read back from int4[] can be written back, but a Float32Array read back from float4[] cannot", async () => {
  expect(await stored("ints", new Int32Array([1, 2]))).toBe('string "{1,2}"');
  expect(await stored("floats", new Float32Array([1.5]))).toBe("throws 42804");
});

test("sql.array() is stored as a parameter of sql.unsafe()", async () => {
  expect(await stored("ints", sql.array([1, 2], "INT"))).toBe('string "{1,2}"');
});

test("sql.array() without a type is stored as the column's array", async () => {
  const [row] = await sql`
    insert into writes (ints, texts)
    values (${sql.array([1, 2])}, ${sql.array(["a", "b"])})
    returning ints::text as ints, texts::text as texts`;

  expect(row).toEqual({ ints: "{1,2}", texts: "{a,b}" });
});

test("sql.array() stores a null element as NULL", async () => {
  const [row] = await sql`
    insert into writes (texts) values (${sql.array(["a", null], "TEXT")})
    returning texts::text as v, texts[2] is null as missing`;

  expect(row).toEqual({ v: "{a,NULL}", missing: true });
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
