/**
 * What the generated file tells the runtime of a database: the journal of
 * its migrations, the newest migration its types were built from, what an
 * `int8` reads as and the columns that hold arrays, with the types
 * themselves carried along.
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

  /**
   * What an `int8` reads as: a string, when the types were generated with
   * `int8: "string"`, and `database()` reads it with Bun's `bigint: false`;
   * a `bigint` otherwise.
   */
  readonly int8?: "bigint" | "string";

  /**
   * The columns that hold arrays, by relation and column as `DB` names
   * them, each with how its literal is written: by the delimiter of its
   * elements — a comma, or what its element type has instead, such as the
   * semicolon of `box` — or as `json`, for an array of json or jsonb, whose
   * elements are written as JSON. `database()` writes a JavaScript array to
   * them as that literal, as Bun binds an array only of a type it knows.
   */
  readonly arrays: Readonly<Record<string, Readonly<Record<string, string>>>>;

  /** Carries `DB` and `Constraint` for the types. */
  readonly [types]?: {
    readonly db: DB;
    readonly constraint: Constraint;
  };
}
