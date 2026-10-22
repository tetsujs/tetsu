/**
 * What Bun.SQL does with the values bound to parameters: what reaches the
 * column, and which values it cannot send at all.
 *
 * A case that names an issue, or says what Bun still gets wrong, pins a
 * Bun bug as it stands: when Bun fixes it, the case fails, and whatever
 * works around it can go. Bun 1.4.4 binds a `Date`, and a JavaScript array
 * to an array of a type it knows, as Postgres reads them, but not a `Date`
 * of a year past 9999 or before 1 to a `date`, an array of a type it does
 * not know, or an array of json whose elements are not all objects: the
 * package writes a `Date` as its ISO text and an array as its Postgres
 * literal, so the literal stays pinned as working.
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
  await sql`create extension if not exists citext`;
  await sql`create type mood as enum ('happy', 'sad')`;
  await sql`create domain positive as int4 check (value > 0)`;
  await sql`create type pair as (a int4, b text)`;
  await sql`create type floatrange as range (subtype = float8)`;
  await sql`
    create table writes (
      id serial primary key,
      doc jsonb, i8 int8, ts timestamp, tstz timestamptz, d date, t time,
      ints int4[], floats float4[], doubles float8[], texts text[], ids uuid[],
      days date[], instants timestamptz[], docs jsonb[],
      moods mood[], positives positive[], pairs pair[], ranges floatrange[],
      names citext[], mood mood
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
const distant = new Date("+010000-01-01T00:00:00Z");
const ancient = new Date("-000043-03-15T00:00:00Z");
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

test("an invalid Date is sent as the text Invalid Date, which Postgres refuses", async () => {
  expect(await stored("tstz", new Date(Number.NaN))).toBe("throws 22007");
  expect(await stored("d", new Date(Number.NaN))).toBe("throws 22007");
});

test("a Date of a year past 9999 or before 1 bound to a timestamp is stored, but a date refuses it, as Bun writes the year as toISOString() does", async () => {
  expect(await stored("tstz", distant)).toBe(
    'string "10000-01-01 00:00:00+00"',
  );
  expect(await stored("ts", ancient)).toBe('string "0044-03-15 00:00:00 BC"');
  expect(await stored("d", distant)).toBe("throws 22009");
  expect(await stored("d", ancient)).toBe("throws 22009");
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

test("a JavaScript array bound to an array of a type Bun does not know is sent as its elements joined by commas, which Postgres refuses", async () => {
  expect(await stored("moods", ["happy", "sad"])).toBe("throws 22P02");
  expect(await stored("positives", [1, 2])).toBe("throws 22P02");
  expect(await stored("pairs", ['(1,"x")'])).toBe("throws 22P02");
  expect(await stored("ranges", ["[1.5,2.5)"])).toBe("throws 22P02");
  expect(await stored("names", ["Ann"])).toBe("throws 22P02");

  const compared = await sql
    .unsafe("select id from writes where mood = any($1)", [["happy"]])
    .then(() => "ok", failure);

  expect(compared).toBe("22P02");
});

test("a JavaScript array bound to jsonb[] stores null as JSON null, and an array element as an array of the literal's own", async () => {
  const [row] = await sql.unsafe(
    "insert into writes (docs) values ($1) returning docs[2] is null as missing, docs[2] = 'null' as json",
    [[{ a: 1 }, null]],
  );

  expect(row).toEqual({ missing: false, json: true });
  expect(await stored("docs", [[1, 2]])).toBe('string "{{1,2}}"');
  expect(await stored("docs", [{ a: 1 }, [1, 2]])).toBe("throws 22P02");
});

test("a Date of a year past 9999 or before 1 in a JavaScript array is refused, of a timestamp too", async () => {
  expect(await stored("days", [date])).toBe('string "{2026-10-09}"');
  expect(await stored("days", [distant])).toBe("throws 22009");
  expect(await stored("instants", [ancient])).toBe("throws 22009");
});

test("-0 in a JavaScript array bound to float8[] is stored as 0", async () => {
  expect(await stored("doubles", [-0, 1.5])).toBe('string "{0,1.5}"');
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
  expect(await stored("moods", "{happy,sad}")).toBe('string "{happy,sad}"');
  expect(await stored("days", "{10000-01-01}")).toBe('string "{10000-01-01}"');
  expect(await stored("doubles", "{-0}")).toBe('string "{-0}"');

  const [row] = await sql.unsafe(
    "insert into writes (texts) values ($1) returning texts",
    [literal],
  );

  expect(row.texts).toEqual(texts);
});
