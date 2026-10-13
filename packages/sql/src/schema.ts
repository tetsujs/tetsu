/**
 * What the generated file tells the runtime of a database: the journal of
 * its migrations and the newest migration its types were built from, with
 * the types themselves carried along.
 *
 * @module
 */

/** The key the types ride on: it is never set. */
declare const types: unique symbol;

/**
 * A database as its generated file describes it: `export const schema` in
 * that file. `DB` is its Kysely types and `Constraint` the names of its
 * constraints, carried for the types only.
 */
export interface Schema<DB, Constraint extends string = string> {
  /** The journal table, as `migrate` is given it. */
  readonly journal: string;

  /** The newest migration the types were built from; `null` with none. */
  readonly migration: {
    readonly name: string;

    /** The SHA-256 of its text, as the journal records it. */
    readonly checksum: string;
  } | null;

  /** Carries `DB` and `Constraint` for the types. */
  readonly [types]?: {
    readonly db: DB;
    readonly constraint: Constraint;
  };
}
