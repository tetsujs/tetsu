/**
 * Telling a broken constraint by its name, the name the database gives it.
 *
 * @module
 */

import { SQL } from "bun";

/**
 * The names of the constraints of an application's databases, as keys.
 * Empty here: each generated file adds the names of its database, so that
 * a name none of them holds is a type error.
 */
// biome-ignore lint/suspicious/noEmptyInterface: generated files add to it, which a type alias cannot be
export interface Constraints {}

/**
 * The name of a constraint: one a generated file registers, or any string
 * while none does.
 */
export type ConstraintName = [keyof Constraints] extends [never]
  ? string
  : keyof Constraints & string;

/**
 * Whether `error` is Postgres refusing a write for breaking the constraint
 * `name`: a unique key or index, a foreign key, a check, of a table or of
 * a domain, or an exclusion constraint.
 *
 * It reads the class of the error's SQLSTATE and the constraint it names,
 * and nothing of its `detail`, which holds the values of the row. A
 * transaction the failure happened in is aborted all the same: answer it
 * outside, or in a savepoint of `atomic()`.
 *
 * @example
 * ```ts
 * try {
 *   await db.insertInto("accounts").values({ email }).execute();
 * } catch (error) {
 *   if (isViolation(error, "accounts_email_key")) {
 *     throw httpError(409, "EMAIL_TAKEN");
 *   }
 *
 *   throw error;
 * }
 * ```
 */
export function isViolation<N extends ConstraintName>(
  error: unknown,
  name: N,
): error is SQL.PostgresError & { readonly constraint: N } {
  return (
    error instanceof SQL.PostgresError &&
    error.errno?.startsWith("23") === true &&
    error.constraint === name
  );
}
