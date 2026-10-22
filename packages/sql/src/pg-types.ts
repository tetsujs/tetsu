/**
 * What Bun.SQL reads each Postgres type as, and whether it parses an array
 * of it: the table the generated types are written from.
 *
 * Every row is what Bun 1.4.4 does, read with `bigint: true`, without
 * parameters and with them, and the tests of this module hold each row to
 * it. Two rows lean on `database()`: Bun reads `int4[]` and `float4[]` with
 * parameters as an `Int32Array` and a `Float32Array`, which it turns into
 * arrays. Types generated with `int8: "string"` read `int8` as
 * {@link INT8_AS_STRING} says instead, as Bun does with `bigint: false`.
 *
 * @module
 */

/**
 * The type a Postgres value reads as. `Date` and `Buffer` are the classes;
 * `unknown` is for a type the table does not know.
 */
export type Reads =
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "Date"
  | "Buffer"
  | "unknown";

/**
 * A column type whose values are written as more than they read as, by
 * the helper type of the generated file that says so.
 *
 * - `Timestamp` — `timestamp` and `timestamptz`, written as a `Date` or a
 *   string.
 * - `CalendarDate` — `date`, the same.
 * - `Json` — `json` and `jsonb`, written as an object or an array.
 * - `Bytea` — `bytea`, written as any `Uint8Array`.
 * - `Int8` — `int8` read as a string, written as a string, a number or a
 *   bigint.
 */
export type Written = "Timestamp" | "CalendarDate" | "Json" | "Bytea" | "Int8";

/** How one Postgres type reads, and how its arrays do. */
export interface PgType {
  /** What a value reads as. */
  readonly reads: Reads;

  /** The helper type, when a value is written as more than it reads as. */
  readonly written?: Written;

  /**
   * Whether Bun parses an array of it. When it does not, it reads the
   * array as its Postgres literal, such as `"{a,b}"`.
   */
  readonly arrays: boolean;
}

/** A type read as a string, with arrays Bun parses. */
const text: PgType = { reads: "string", arrays: true };

/**
 * `int8` in types generated with `int8: "string"`, which `database()` reads
 * with `bigint: false`: as a string, its arrays as arrays of strings.
 */
export const INT8_AS_STRING: PgType = {
  reads: "string",
  written: "Int8",
  arrays: true,
};

/** A type read as a string, with arrays Bun reads as their literal. */
const literal: PgType = { reads: "string", arrays: false };

/** The types of `pg_catalog`, by name. */
export const BUILT_IN: Readonly<Record<string, PgType>> = {
  bool: { reads: "boolean", arrays: true },
  int2: { reads: "number", arrays: true },
  int4: { reads: "number", arrays: true },
  oid: { reads: "number", arrays: true },
  int8: { reads: "bigint", arrays: true },
  float4: { reads: "number", arrays: true },
  float8: { reads: "number", arrays: true },
  numeric: text,
  money: text,
  text,
  varchar: text,
  bpchar: text,
  name: text,
  char: text,
  uuid: text,
  json: { reads: "unknown", written: "Json", arrays: true },
  jsonb: { reads: "unknown", written: "Json", arrays: true },
  timestamp: { reads: "Date", written: "Timestamp", arrays: true },
  timestamptz: { reads: "Date", written: "Timestamp", arrays: true },
  date: { reads: "Date", written: "CalendarDate", arrays: true },
  time: text,
  timetz: text,
  interval: text,
  bytea: { reads: "Buffer", written: "Bytea", arrays: true },
  inet: text,
  cidr: text,
  macaddr: text,
  macaddr8: text,
  bit: text,
  varbit: text,
  point: text,
  line: text,
  lseg: text,
  box: text,
  path: text,
  polygon: text,
  circle: text,
  xml: text,
  tsvector: text,
  tsquery: text,
  pg_lsn: text,
  int4range: text,
  int8range: text,
  numrange: text,
  tsrange: text,
  tstzrange: text,
  daterange: text,
  int4multirange: text,
  int8multirange: text,
  nummultirange: text,
  tsmultirange: text,
  tstzmultirange: text,
  datemultirange: text,
  regclass: text,
  regtype: text,
  regproc: text,
  regprocedure: text,
  regoper: text,
  regoperator: text,
  regnamespace: text,
  regrole: text,
  regconfig: text,
  regdictionary: text,
  regcollation: text,
  int2vector: text,
  oidvector: text,
};

/**
 * Types of extensions, by name, wherever the extension is installed. Their
 * arrays have an OID that differs from one database to the next, which
 * Bun does not know.
 */
export const EXTENSION: Readonly<Record<string, PgType>> = {
  citext: literal,
};

/**
 * Types Postgres makes of a definition — an enum, a composite, a range or
 * a multirange of one's own — by `pg_type.typtype`, past the enums, which
 * read as their labels. Bun reads a value of any of them as its text, and
 * an array of them as its literal.
 */
export const DEFINED: Readonly<Record<string, PgType>> = {
  e: literal,
  c: literal,
  r: literal,
  m: literal,
};
