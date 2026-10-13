/**
 * The table the generated types are written from, held to Bun row by row:
 * a value of each type, and an array of one, read both ways Bun reads —
 * without parameters and with one — by a client with `bigint: true`, as
 * `database()` reads them.
 *
 * Bun reads `int4[]` and `float4[]` with a parameter as an `Int32Array`
 * and a `Float32Array`; `database()` makes arrays of them, so the table
 * says arrays, and so does this test of the two.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { testDatabase } from "../test-utils/database.ts";
import type { PgType, Reads } from "./pg-types.ts";
import { BUILT_IN, DEFINED, EXTENSION } from "./pg-types.ts";

const { url } = testDatabase();
const sql = new SQL(url, { bigint: true, connection: { TimeZone: "UTC" } });

beforeAll(async () => {
  await sql
    .unsafe(`
    create extension if not exists citext;
    create type mood as enum ('happy', 'sad');
    create type pair as (n int4, s text);
    create type float_range as range (subtype = float8);
  `)
    .simple();
});

afterAll(async () => {
  await sql.close();
});

/** A value of each type of `pg_catalog` the table knows. */
const SAMPLES: Readonly<Record<string, string>> = {
  bool: "true",
  int2: "1",
  int4: "1",
  oid: "1",
  int8: "1",
  float4: "1.5",
  float8: "1.5",
  numeric: "1.5",
  money: "'1.50'",
  text: "'a'",
  varchar: "'a'",
  bpchar: "'a'",
  name: "'a'",
  char: "'a'",
  uuid: "'0199d0b2-7a3c-7cc0-9b7e-3f6a1c2d4e5f'",
  json: `'{"a":1}'`,
  jsonb: `'{"a":1}'`,
  timestamp: "'2026-10-12 12:00'",
  timestamptz: "'2026-10-12 12:00+00'",
  date: "'2026-10-12'",
  time: "'12:00'",
  timetz: "'12:00+03'",
  interval: "'1 day'",
  bytea: "'\\xdead'",
  inet: "'10.0.0.1'",
  cidr: "'10.0.0.0/8'",
  macaddr: "'08:00:2b:01:02:03'",
  macaddr8: "'08:00:2b:01:02:03:04:05'",
  bit: "B'101'",
  varbit: "B'10'",
  point: "'(1,2)'",
  line: "'{1,2,3}'",
  lseg: "'[(1,2),(3,4)]'",
  box: "'((1,2),(3,4))'",
  path: "'((1,2),(3,4))'",
  polygon: "'((1,2),(3,4),(5,6))'",
  circle: "'<(1,2),3>'",
  xml: "'<a/>'",
  tsvector: "'a b'",
  tsquery: "'a & b'",
  pg_lsn: "'0/16B3748'",
  int4range: "'[1,5)'",
  int8range: "'[1,5)'",
  numrange: "'[1.5,2.5)'",
  tsrange: `'["2026-10-12 12:00","2026-10-12 13:00")'`,
  tstzrange: `'["2026-10-12 12:00+00","2026-10-12 13:00+00")'`,
  daterange: "'[2026-10-12,2026-10-13)'",
  int4multirange: "'{[1,5)}'",
  int8multirange: "'{[1,5)}'",
  nummultirange: "'{[1.5,2.5)}'",
  tsmultirange: `'{["2026-10-12 12:00","2026-10-12 13:00")}'`,
  tstzmultirange: `'{["2026-10-12 12:00+00","2026-10-12 13:00+00")}'`,
  datemultirange: "'{[2026-10-12,2026-10-13)}'",
  regclass: "'pg_class'",
  regtype: "'int4'",
  regproc: "'now'",
  regprocedure: "'now()'",
  regoper: "'||/'",
  regoperator: "'+(integer,integer)'",
  regnamespace: "'public'",
  regrole: "'pg_database_owner'",
  regconfig: "'english'",
  regdictionary: "'simple'",
  regcollation: `'"C"'`,
  int2vector: "'1 2'",
  oidvector: "'1 2'",
};

/** The typed arrays Bun reads arrays of these types as, with a parameter. */
const TYPED_ARRAYS: Readonly<Record<string, string>> = {
  int4: "Int32Array",
  float4: "Float32Array",
};

/** Reads one expression, without parameters or with one. */
async function read(
  expression: string,
  path: "text" | "binary",
): Promise<unknown> {
  const rows =
    path === "text"
      ? await sql.unsafe(`select ${expression} as v`)
      : await sql.unsafe(`select ${expression} as v where $1::int = 1`, [1]);

  return rows[0].v;
}

/** Whether a value is of the type a row of the table says it reads as. */
function isOf(value: unknown, reads: Reads): boolean {
  switch (reads) {
    case "Date":
      return value instanceof Date;
    case "Buffer":
      return Buffer.isBuffer(value);
    case "unknown":
      return value !== undefined;
    default:
      return typeof value === reads;
  }
}

/** Holds a value and an array of it, both ways, to a row of the table. */
async function holds(type: string, sample: string, row: PgType): Promise<void> {
  const cast = type === "char" ? '"char"' : type;

  for (const path of ["text", "binary"] as const) {
    const value = await read(`${sample}::${cast}`, path);
    const array = await read(`array[${sample}::${cast}]`, path);
    const typed = path === "binary" ? TYPED_ARRAYS[type] : undefined;

    expect({ path, value: isOf(value, row.reads) }).toEqual({
      path,
      value: true,
    });

    if (!row.arrays) {
      expect({ path, literal: typeof array }).toEqual({
        path,
        literal: "string",
      });
    } else if (typed !== undefined) {
      expect({ path, array: array?.constructor.name }).toEqual({
        path,
        array: typed,
      });
    } else {
      expect({
        path,
        array: Array.isArray(array) && isOf(array[0], row.reads),
      }).toEqual({ path, array: true });
    }
  }
}

describe("a type of pg_catalog", () => {
  test("has a sample for each, and the table knows each sample's", () => {
    expect(Object.keys(SAMPLES).toSorted()).toEqual(
      Object.keys(BUILT_IN).toSorted(),
    );
  });

  test.each(Object.entries(BUILT_IN))(
    "%s reads as the table says",
    async (type, row) => {
      await holds(type, SAMPLES[type] ?? "", row);
    },
  );
});

describe("a type Postgres makes of a definition, and an extension's", () => {
  test.each([
    ["an enum", "mood", "'happy'", DEFINED.e],
    ["a composite", "pair", "row(1, 'a')", DEFINED.c],
    ["a range", "float_range", "'[1.5,2.5)'", DEFINED.r],
    ["a multirange", "float_multirange", "'{[1.5,2.5)}'", DEFINED.m],
    ["citext", "citext", "'A'", EXTENSION.citext],
  ])("%s reads as the table says", async (_, type, sample, row) => {
    expect(row).toBeDefined();
    await holds(type, sample, row as PgType);
  });
});
