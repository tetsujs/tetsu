/**
 * What the generated file of queries runs a query of a file with: on the
 * Kysely of `database()`, its parameters taken by name, and its values as
 * that Kysely's driver binds and reads them.
 *
 * @module
 */

import type { ControlledTransaction, Kysely, Transaction } from "kysely";
import { CompiledQuery } from "kysely";
import { arrayLiteral } from "./values.ts";

/** A query of a file, as the generated file holds it. */
export interface FileQuery {
  /** Its text, its parameters numbered `$1` on. */
  readonly text: string;

  /** The names of its parameters, `$1` first. */
  readonly names: readonly string[];

  /**
   * How an array is written to each parameter that takes one, by its
   * name: by the delimiter of its elements, or as `json`.
   */
  readonly arrays: Readonly<Record<string, string>>;
}

/**
 * Runs `query` on `db`, the database or a transaction, with the values of
 * `params`, and resolves to its rows: what a function of the generated
 * file of queries does.
 *
 * @throws {TypeError} when `params` lacks a parameter of the query.
 */
export async function queryRows<DB, Row>(
  db: Kysely<DB> | Transaction<DB> | ControlledTransaction<DB>,
  query: FileQuery,
  params: object = {},
): Promise<Row[]> {
  const { rows } = await db.executeQuery(compiled<Row>(query, params));

  return rows;
}

/**
 * Runs `query`, which returns no rows, on `db`, the database or a
 * transaction, with the values of `params`, and resolves to how many rows
 * it inserted, updated, deleted or merged: what a function of the
 * generated file of queries does.
 *
 * @throws {TypeError} when `params` lacks a parameter of the query.
 */
export async function queryCount<DB>(
  db: Kysely<DB> | Transaction<DB> | ControlledTransaction<DB>,
  query: FileQuery,
  params: object = {},
): Promise<bigint> {
  const { numAffectedRows } = await db.executeQuery(compiled(query, params));

  return numAffectedRows ?? 0n;
}

/**
 * A query with its values: each parameter's, by its name; an array to a
 * parameter of arrays as the literal Postgres reads, which Bun cannot
 * bind; and a number that is not whole as its text, which Postgres reads
 * as the parameter's type, so that an integer one refuses it rather than
 * round the `float8` Bun would bind.
 */
function compiled<Row>(query: FileQuery, params: object): CompiledQuery<Row> {
  return CompiledQuery.raw(
    query.text,
    query.names.map((name) => {
      const value = Object.hasOwn(params, name)
        ? (params as Readonly<Record<string, unknown>>)[name]
        : undefined;
      const written = Object.hasOwn(query.arrays, name)
        ? query.arrays[name]
        : undefined;

      if (value === undefined) {
        throw new TypeError(
          `the query takes :${name}, which its parameters do not hold`,
        );
      }

      if (
        written !== undefined &&
        (Array.isArray(value) || ArrayBuffer.isView(value))
      ) {
        return arrayLiteral(Array.from(value as ArrayLike<unknown>), written);
      }

      return typeof value === "number" && !Number.isInteger(value)
        ? String(value)
        : value;
    }),
  ) as CompiledQuery<Row>;
}
