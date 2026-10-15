/**
 * Helpers for the platform tests: how Bun.SQL is asked for a value, and a
 * description of what came back that is exact about its JavaScript type.
 *
 * A description such as `Int32Array [1, 2]` or `string "5"` names the type
 * along with the value, which `toEqual` does not always tell apart — it
 * holds a `Buffer` equal to a `Uint8Array` — and reads as the table it is.
 *
 * @module
 */

import type { SQL } from "bun";

/**
 * How a query reaches Postgres. Bun reads the result of a query without
 * parameters in the text format and of one with parameters in the binary
 * format, and some types come back differently from the two.
 */
export type Path = "text" | "binary";

/** Describes a value by its JavaScript type and contents. */
export function show(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "string") {
    return `string ${JSON.stringify(value)}`;
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return `${typeof value} ${String(value)}`;
  }

  if (value instanceof Date) {
    return `Date ${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()}`;
  }

  if (ArrayBuffer.isView(value)) {
    const items = Array.from(value as unknown as ArrayLike<number>);

    return `${value.constructor.name} [${items.join(", ")}]`;
  }

  if (Array.isArray(value)) {
    return `Array [${value.map(show).join(", ")}]`;
  }

  return `${value.constructor.name} ${JSON.stringify(value)}`;
}

/**
 * Selects one expression on the given path and describes the value, or
 * what the failure carried: `throws` and its {@link failure}.
 */
export async function read(
  sql: SQL,
  expression: string,
  path: Path,
): Promise<string> {
  try {
    const rows =
      path === "text"
        ? await sql.unsafe(`select ${expression} as v`)
        : await sql.unsafe(`select ${expression} as v where $1::int = 1`, [1]);

    return show(rows[0].v);
  } catch (error) {
    return `throws ${failure(error)}`;
  }
}

/**
 * The SQLSTATE of an error the server sent, otherwise the client's own
 * code: Bun gives some server errors a code of their own, such as
 * `ERR_POSTGRES_SYNTAX_ERROR`, and keeps the SQLSTATE in `errno`.
 */
export function failure(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const { errno, code } = error as { errno?: unknown; code?: unknown };

  return String(errno ?? code);
}
