/**
 * How a JavaScript value is written as Postgres text, where Bun does not
 * bind the value itself as Postgres reads it: a `Date` as its ISO text, an
 * array as the literal of a Postgres array.
 *
 * @module
 */

/**
 * The ISO text of a `Date`, which `timestamp`, `timestamptz` and `date`
 * all read: a `timestamptz` as the instant, a `timestamp` as its time in
 * UTC, a `date` as its day in UTC. Bun binds a `Date` so too, but for a
 * year past 9999 or before 1, which it writes as `toISOString()` does, and
 * which a `date`, and an array of any of the three, refuse.
 *
 * A year past 9999 is written as its digits, which `toISOString()` writes
 * as `+010000`, and a year before 1 as the year Before Christ it is, which
 * Postgres counts from 1 BC, the year 0 of the ISO calendar: `-000043` is
 * `0044 … BC`.
 *
 * @throws {RangeError} when the `Date` is invalid, before anything is sent:
 * Bun would send it as the text `Invalid Date`, which Postgres refuses.
 */
export function isoOf(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("an invalid Date cannot be written: it holds no time");
  }

  const iso = date.toISOString();
  const year = date.getUTCFullYear();

  if (year >= 1 && year <= 9999) {
    return iso;
  }

  const rest = iso.slice(iso.indexOf("-", 1));

  return year > 9999
    ? `${year}${rest}`
    : `${String(1 - year).padStart(4, "0")}${rest} BC`;
}

/**
 * How the literal of an array of json or jsonb is written, in place of the
 * delimiter of its elements, which is a comma.
 */
export const JSON_ELEMENTS = "json";

/**
 * The literal of a Postgres array of `values`, written as `written` says:
 * by the delimiter of its elements, or as {@link JSON_ELEMENTS}.
 *
 * By a delimiter — a comma for most types, a semicolon for `box`, what
 * the element type's `typdelim` says — an element that is an array is an
 * array of the literal's own, so that an array of arrays, as Bun reads a
 * two-dimensional one, is written as the array it was. Any other element
 * is quoted, so that nothing in its text is read as part of the literal,
 * and is written as its text: a string as it is, a `Date` as its ISO
 * text, a `Uint8Array` as the hex a `bytea` reads, any other object as
 * JSON, and anything else as `String` writes it.
 *
 * As JSON, each element is the JSON of its value, quoted, an array among
 * them: a value of json, as Bun writes one bound on its own.
 *
 * Either way, `null` and `undefined`, and a hole, are NULL.
 *
 * @throws {RangeError} when an element is an invalid `Date`.
 */
export function arrayLiteral(
  values: readonly unknown[],
  written: string,
): string {
  return written === JSON_ELEMENTS
    ? `{${Array.from(values, jsonElement).join(",")}}`
    : `{${Array.from(values, (value) =>
        Array.isArray(value) ? arrayLiteral(value, written) : element(value),
      ).join(written)}}`;
}

/** An element of an array literal: NULL, or its text, quoted. */
function element(value: unknown): string {
  return value === null || value === undefined ? "NULL" : quoted(textOf(value));
}

/** An element of an array of json: NULL, or the JSON of its value, quoted. */
function jsonElement(value: unknown): string {
  return value === null || value === undefined
    ? "NULL"
    : quoted(JSON.stringify(value));
}

/** The text of an element, quoted as an array literal reads it. */
function quoted(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The text of a value an element holds. */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return isoOf(value);
  }

  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return Object.is(value, -0) ? "-0" : String(value);
}
