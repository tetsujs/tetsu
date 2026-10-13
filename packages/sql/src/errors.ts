/**
 * The error the migration runner, `createMigration` and `verifySchema`
 * fail with.
 *
 * @module
 */

/**
 * Why a migration run was refused or failed, or why `verifySchema` found
 * the database unlike the types.
 *
 * Every reason but `failed` and `own-transaction` is found before anything
 * is applied, so the database is as it was.
 *
 * - `directory` — the migrations directory is not there.
 * - `name` — a `.sql` file is not named `YYYYMMDDHHMMSS_name.sql`, or a new
 *   migration's name is not lowercase letters, digits and underscores, or
 *   its file exists.
 * - `empty` — a pending migration holds nothing to run.
 * - `table` — the journal table exists and is not a journal.
 * - `behind` — the database has not applied the migration the types were
 *   built from: `verifySchema` found it missing from the journal, or no
 *   journal at all.
 * - `missing` — an applied migration's file is gone, though newer files are
 *   there, or the directory holds no migration files. One newer than every
 *   file is not missing: the code was rolled back, and `migrate` names it
 *   in `ahead`.
 * - `changed` — an applied migration's file has changed, or, for
 *   `verifySchema`, the types were built from another text of it.
 * - `out-of-order` — a pending migration is older than the last applied one.
 * - `failed` — a migration failed; it was rolled back, unless it runs
 *   without a transaction. The Postgres error is the `cause`.
 * - `own-transaction` — a migration ended the transaction it runs in with
 *   a `COMMIT` or `ROLLBACK` of its own, so part of it may stay applied
 *   without being recorded.
 */
export type MigrationErrorReason =
  | "directory"
  | "name"
  | "empty"
  | "table"
  | "behind"
  | "missing"
  | "changed"
  | "out-of-order"
  | "failed"
  | "own-transaction";

/** A migration run that was refused or failed, with the file to blame. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";

  /** Why the run stopped. */
  readonly reason: MigrationErrorReason;

  /** The migration file to blame, when there is one. */
  readonly migration: string | undefined;

  /**
   * The migrations the run applied before it stopped, in order: none,
   * unless a migration failed or ended its own transaction after others.
   */
  readonly applied: readonly string[];

  constructor(
    reason: MigrationErrorReason,
    message: string,
    options: {
      readonly migration?: string;
      readonly cause?: unknown;
      readonly applied?: readonly string[];
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.reason = reason;
    this.migration = options.migration;
    this.applied = options.applied ?? [];
  }
}
