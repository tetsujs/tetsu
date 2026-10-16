/**
 * What Bun.SQL hands back for each Postgres type: the table the generated
 * types are written from.
 *
 * Each value is read four ways — without parameters and with one, which
 * Bun reads in the text and the binary format, by a client with and one
 * without `bigint: true` — and the four must match the case. A case that
 * names an issue pins a Bun bug as it stands: when Bun fixes it, the case
 * fails, and whatever works around it can go. Both clients run with the
 * session time zone set to UTC, which is how Postgres prints a timestamp
 * inside JSON.
 *
 * @module
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { testDatabase } from "../test-utils/database.ts";
import { read } from "./values.ts";

afterAll(async () => {
  await sql.close();
  await big.close();
});

const { url } = testDatabase();
const connection = { TimeZone: "UTC" };
const sql = new SQL(url, { connection });
const big = new SQL(url, { bigint: true, connection });

beforeAll(async () => {
  await sql`create type mood as enum ('happy', 'sad')`;
  await sql`create domain positive as int4 check (value > 0)`;
});

interface Case {
  /** The expression selected. */
  readonly sql: string;

  /** What it reads as, unless one of the fields below says otherwise. */
  readonly reads: string;

  /** What it reads as with a parameter, in the binary format. */
  readonly binary?: string;

  /** What it reads as with `bigint: true`, on both paths. */
  readonly bigint?: string;

  /** The oven-sh/bun issue of the Bun bug the case pins. */
  readonly issue?: number;
}

const uuid = "0199d0b2-7a3c-7cc0-9b7e-3f6a1c2d4e5f";

const cases: Case[] = [
  { sql: "'1'::int2", reads: "number 1" },
  { sql: "'2'::int4", reads: "number 2" },
  { sql: "'5'::int8", reads: 'string "5"', bigint: "bigint 5" },
  {
    sql: "'9007199254740993'::int8",
    reads: 'string "9007199254740993"',
    bigint: "bigint 9007199254740993",
  },
  {
    sql: "'1.1'::float4",
    reads: "number 1.1",
    binary: "number 1.100000023841858",
  },
  { sql: "'1.1'::float8", reads: "number 1.1" },
  {
    sql: "'12345678901234567890.123456789'::numeric",
    reads: 'string "12345678901234567890.123456789"',
  },
  { sql: "'12.5'::numeric(12,2)", reads: 'string "12.50"' },
  { sql: "'0'::numeric(12,4)", reads: 'string "0.0000"' },
  { sql: "true", reads: "boolean true" },
  { sql: "'text'::text", reads: 'string "text"' },
  { sql: "'vc'::varchar(10)", reads: 'string "vc"' },
  { sql: "'ab'::char(3)", reads: 'string "ab "' },
  { sql: `'${uuid}'::uuid`, reads: `string "${uuid}"` },
  { sql: `'{"a":1}'::json`, reads: 'Object {"a":1}' },
  { sql: `'{"a":1}'::jsonb`, reads: 'Object {"a":1}' },
  {
    sql: `'{"n":9007199254740993}'::jsonb`,
    reads: 'Object {"n":9007199254740992}',
  },
  { sql: `'"s"'::jsonb`, reads: 'string "s"' },
  { sql: "'[1,2]'::jsonb", reads: "Array [number 1, number 2]" },
  {
    sql: "'2026-10-09 12:00:00'::timestamp",
    reads: "Date 2026-10-09T12:00:00.000Z",
  },
  {
    sql: "'2026-10-09 12:00:00+00'::timestamptz",
    reads: "Date 2026-10-09T12:00:00.000Z",
  },
  { sql: "'infinity'::timestamptz", reads: "number Infinity" },
  { sql: "'-infinity'::timestamptz", reads: "number -Infinity" },
  { sql: "'2026-10-09'::date", reads: "Date 2026-10-09T00:00:00.000Z" },
  { sql: "'12:34:56'::time", reads: 'string "12:34:56"' },
  { sql: "'12:34:56+03'::timetz", reads: 'string "12:34:56+03"' },
  { sql: "'1 day 2 hours'::interval", reads: 'string "1 day 02:00:00"' },
  { sql: "'\\xdeadbeef'::bytea", reads: "Buffer [222, 173, 190, 239]" },
  { sql: "'10.0.0.1'::inet", reads: 'string "10.0.0.1"' },
  { sql: "'[1,5)'::int4range", reads: 'string "[1,5)"' },
  { sql: "'happy'::mood", reads: 'string "happy"' },
  { sql: "'7'::positive", reads: "number 7" },
  { sql: "42::oid", reads: "number 42" },
  { sql: "'{1,2}'::int2[]", reads: "Array [number 1, number 2]" },
  {
    sql: "'{1,2}'::int4[]",
    reads: "Array [number 1, number 2]",
    binary: "Int32Array [1, 2]",
  },
  {
    sql: "'{1.5,2.5}'::float4[]",
    reads: "Array [number 1.5, number 2.5]",
    binary: "Float32Array [1.5, 2.5]",
  },
  {
    sql: "'{5,9007199254740993}'::int8[]",
    reads: 'Array [string "5", string "9007199254740993"]',
    bigint: "Array [bigint 5, bigint 9007199254740993]",
  },
  { sql: "'{1.5,2.5}'::float8[]", reads: "Array [number 1.5, number 2.5]" },
  {
    sql: "'{1.1,2.2}'::numeric[]",
    reads: 'Array [string "1.1", string "2.2"]',
  },
  {
    sql: "'{true,false}'::bool[]",
    reads: "Array [boolean true, boolean false]",
  },
  { sql: "'{a,b}'::text[]", reads: 'Array [string "a", string "b"]' },
  {
    sql: `'{"2026-10-09 12:00:00+00"}'::timestamptz[]`,
    reads: "Array [Date 2026-10-09T12:00:00.000Z]",
  },
  { sql: `array['{"a":1}'::jsonb]`, reads: 'Array [Object {"a":1}]' },
  { sql: "'{a,NULL}'::text[]", reads: 'Array [string "a", null]' },
  {
    sql: "'{1,NULL}'::int8[]",
    reads: 'Array [string "1", null]',
    bigint: "Array [bigint 1, null]",
  },
  {
    sql: "'{{a,b},{c,d}}'::text[]",
    reads:
      'Array [Array [string "a", string "b"], Array [string "c", string "d"]]',
  },
  { sql: `'{${uuid}}'::uuid[]`, reads: `string "{${uuid}}"`, issue: 41039 },
  { sql: "'{happy,sad}'::mood[]", reads: 'string "{happy,sad}"', issue: 41040 },
  { sql: "'{1,2}'::positive[]", reads: 'string "{1,2}"', issue: 41040 },
  {
    sql: "'{1,NULL}'::int4[]",
    reads: "Array [number 1, null]",
    binary: "throws ERR_POSTGRES_NULLS_IN_ARRAY_NOT_SUPPORTED_YET",
    issue: 45062,
  },
  {
    sql: "'{1.5,NULL}'::float4[]",
    reads: "Array [number 1.5, null]",
    binary: "throws ERR_POSTGRES_NULLS_IN_ARRAY_NOT_SUPPORTED_YET",
    issue: 45062,
  },
  {
    sql: "'{{1,2},{3,4}}'::int4[]",
    reads: "Array [Array [number 1, number 2], Array [number 3, number 4]]",
    binary: "throws ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET",
    issue: 45062,
  },
  {
    sql: "(select count(*) from generate_series(1, 3))",
    reads: 'string "3"',
    bigint: "bigint 3",
  },
  {
    sql: "(select sum(x) from (values (5::int8)) as t(x))",
    reads: 'string "5"',
  },
  {
    sql: "(select sum(x) from (values (2::int4)) as t(x))",
    reads: 'string "2"',
    bigint: "bigint 2",
  },
  {
    sql: "(select avg(x) from (values (2::int4)) as t(x))",
    reads: 'string "2.0000000000000000"',
  },
  {
    sql: "json_build_array(9007199254740993::int8, '2026-10-09 12:00:00+00'::timestamptz)",
    reads:
      'Array [number 9007199254740992, string "2026-10-09T12:00:00+00:00"]',
  },
];

for (const each of cases) {
  const name = [
    `${each.sql} reads as ${each.reads}`,
    each.binary === undefined ? "" : `, with a parameter as ${each.binary}`,
    each.bigint === undefined ? "" : `, with bigint as ${each.bigint}`,
    each.issue === undefined ? "" : `, still oven-sh/bun#${each.issue}`,
  ].join("");

  test(name, async () => {
    expect({
      text: await read(sql, each.sql, "text"),
      binary: await read(sql, each.sql, "binary"),
      bigintText: await read(big, each.sql, "text"),
      bigintBinary: await read(big, each.sql, "binary"),
    }).toEqual({
      text: each.reads,
      binary: each.binary ?? each.reads,
      bigintText: each.bigint ?? each.reads,
      bigintBinary: each.bigint ?? each.binary ?? each.reads,
    });
  });
}
