/**
 * The migration runner: applies the pending migrations of a directory, each
 * in a transaction of its own, and records each in a journal table.
 *
 * Before anything is applied, every applied migration must still have its
 * file, unchanged, and every pending one must be newer than the last
 * applied: the database is then built in the order of the files, which is
 * the order the types are generated in. Only applied migrations newer than
 * every file may have none: a newer version of the code applied them, and
 * this one is older than the database, as after a rollback. A run holds an
 * advisory lock for its whole length, so runners started together apply
 * each migration once.
 *
 * @module
 */

import type { ReservedSQL, SQL } from "bun";
import { MigrationError } from "./errors.ts";
import type { MigrationFile } from "./migration-files.ts";
import { isEmpty, readMigrations } from "./migration-files.ts";

/** Where the migrations are, and how a run treats them. */
export interface MigrateOptions {
  /** The directory of the migration files, from the working directory. */
  readonly dir: string;

  /**
   * The journal table, as `table` or `schema.table`, in lowercase letters,
   * digits and underscores. `migrations` by default, in the first schema
   * of the `search_path`. A table of that name that is not a journal is
   * refused, never written to.
   */
  readonly table?: string;

  /**
   * How long a statement of a migration may wait for a lock, in
   * milliseconds; `0` waits as long as it takes. 5000 by default.
   *
   * A statement waiting for a lock holds up every later query that needs
   * the same lock, so an `ALTER TABLE` behind a long transaction stalls
   * the application. Failing early, and running again later, does not. A
   * `-- no-transaction` migration is not limited: see {@link migrate}.
   */
  readonly lockTimeoutMs?: number;

  /**
   * Where the run reports its steps, as it takes them. Nothing by default.
   *
   * Takes the record rather than a string so a structured logger can be
   * handed the fields as they are. A failure is not written: it is thrown.
   * A `write` that throws stops the run where it is.
   *
   * @example
   * ```ts
   * await migrate(sql, {
   *   dir: "./migrations",
   *   write: (record) => logger.info(record, "migration"),
   * });
   * ```
   */
  readonly write?: (record: MigrationRecord) => void;
}

/**
 * A step of a run, as {@link MigrateOptions.write} gets it.
 *
 * - `waiting` — another run holds the lock, and this one waits for it.
 * - `ahead` — an applied migration is newer than every file: see
 *   {@link MigrateResult.ahead}.
 * - `applying` — a migration is about to run: the only trace of one that
 *   hangs, or whose process is killed.
 * - `applied` — a migration ran and was recorded, in `durationMs`
 *   milliseconds, rounded to the microsecond.
 */
export type MigrationRecord =
  | { readonly event: "waiting" }
  | { readonly event: "ahead"; readonly migration: string }
  | { readonly event: "applying"; readonly migration: string }
  | {
      readonly event: "applied";
      readonly migration: string;
      readonly durationMs: number;
    };

/** What a run did. */
export interface MigrateResult {
  /** The migrations applied by this run, in the order they ran. */
  readonly applied: readonly string[];

  /**
   * The applied migrations newer than every file, in order: the database is
   * ahead of the code, which a newer version migrated before this one came
   * back. Empty unless the code was rolled back.
   */
  readonly ahead: readonly string[];
}

/** The first key of the runner's advisory lock: `tsql` in ASCII. */
const LOCK_CLASS = 1953722732;

/** What a journal table name looks like. */
const TABLE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;

/** The columns of a journal, with their types, in order. */
const JOURNAL = [
  "name text",
  "checksum text",
  "applied_at timestamp with time zone",
];

/**
 * Brings the session back to its defaults: settings, role and temporary
 * tables. A run starts from them, and each journal row is written with
 * them, which also leaves them to the next migration, whatever the one
 * before set for the session. Resetting the session authorization resets
 * a role set with `SET ROLE` too.
 */
const RESET = "reset all; reset session authorization; discard temp";

/**
 * Applies the pending migrations of `dir` and returns their names.
 *
 * Each migration runs in a transaction of its own and is recorded in the
 * same transaction, so a failure leaves it neither applied nor recorded.
 * An applied migration whose file is gone is refused, unless it is newer
 * than every file: then the code was rolled back past it, and the run
 * names it in `ahead` and applies nothing.
 * Each starts from the session's defaults: what one sets for the session,
 * such as `search_path` or a role, does not reach the next one or the
 * journal.
 *
 * A migration whose first line is `-- no-transaction` runs outside one, as
 * `CREATE INDEX CONCURRENTLY` must, and is recorded once it has run.
 * Postgres runs the statements of such a file together, so a
 * `CONCURRENTLY` statement must be the only one in it. It cannot set its
 * own timeouts, so it runs with none: `CREATE INDEX CONCURRENTLY` waits for
 * every older transaction in the database to end, without holding up the
 * application, and building the index may take long. A `CREATE INDEX
 * CONCURRENTLY` that fails leaves an invalid index behind: drop it with
 * `DROP INDEX CONCURRENTLY` before running the migration again.
 *
 * The run uses one connection of `sql` and closes it at the end, so
 * nothing a migration set for its session reaches the application. A
 * runner started while another runs waits for it, however long it takes.
 * Pass a client of its own when migrations run as a role with rights the
 * application has not.
 *
 * @example
 * ```ts
 * import { SQL } from "bun";
 * import { migrate } from "@tetsujs/sql";
 *
 * const sql = new SQL(Bun.env.DATABASE_URL);
 * const { applied } = await migrate(sql, { dir: "./migrations" });
 *
 * await sql.close();
 * ```
 *
 * @throws {MigrationError} when a run is refused or a migration fails; its
 * `reason` says which, and its `applied` names what the run applied first.
 * @throws {TypeError} when an option is invalid, or `sql` is not a
 * Postgres client.
 * @throws the client's own error when the connection fails outside a
 * migration.
 */
export async function migrate(
  sql: SQL,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { write } = options;
  const table = options.table ?? "migrations";
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;

  if (sql.options.adapter !== "postgres") {
    throw new TypeError(
      `migrate runs on Postgres, and this client is for ${String(sql.options.adapter)}`,
    );
  }

  if (!TABLE.test(table)) {
    throw new TypeError(
      `"${table}" cannot name the journal: use table or schema.table, in lowercase letters, digits and underscores`,
    );
  }

  if (
    !Number.isInteger(lockTimeoutMs) ||
    lockTimeoutMs < 0 ||
    lockTimeoutMs > 2 ** 31 - 1
  ) {
    throw new TypeError(
      `lockTimeoutMs must be a whole number of milliseconds from 0 to 2147483647, not ${String(lockTimeoutMs)}`,
    );
  }

  const files = await readMigrations(options.dir);
  const connection = await sql.reserve();

  try {
    await connection.unsafe(RESET).simple();

    const journal = await journalOf(connection, table);

    await connection.begin(async (tx) => {
      await liftTimeouts(tx, true);

      const [lock] =
        await tx`select pg_try_advisory_lock(${LOCK_CLASS}, hashtext(${journal})) as taken`;

      if (!lock.taken) {
        write?.({ event: "waiting" });
        await tx`select pg_advisory_lock(${LOCK_CLASS}, hashtext(${journal}))`;
      }
    });
    await openJournal(connection, journal);

    const { pending, ahead } = planOf(
      files,
      await appliedIn(connection, journal),
    );
    const applied: string[] = [];

    for (const name of ahead) {
      write?.({ event: "ahead", migration: name });
    }

    for (const file of pending) {
      const startedAt = performance.now();

      write?.({ event: "applying", migration: file.name });
      await apply(connection, journal, file, { lockTimeoutMs, applied });
      applied.push(file.name);
      write?.({
        event: "applied",
        migration: file.name,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      });
    }

    return { applied, ahead };
  } finally {
    await connection.close();
  }
}

/**
 * Lifts the timeouts of the session, or with `local` of its transaction
 * only: for the wait for the runner's lock, and for a migration outside a
 * transaction. Postgres before 17 has no transaction timeout, so only the
 * settings the server has are set.
 */
async function liftTimeouts(sql: SQL, local: boolean): Promise<void> {
  await sql`
    select set_config(name, '0', ${local}) from pg_settings
    where name in ('lock_timeout', 'statement_timeout', 'transaction_timeout')`;
}

/**
 * The journal's name, schema-qualified and quoted: the table that name
 * finds, or where `create table` would put it. It is resolved once, before
 * anything runs, so a migration that changes the `search_path` cannot move
 * it, and runners that name it `migrations` and `public.migrations` take
 * the same lock.
 */
async function journalOf(
  connection: ReservedSQL,
  table: string,
): Promise<string> {
  const dot = table.indexOf(".");
  const schema = dot === -1 ? null : table.slice(0, dot);
  const [found] = await connection`
    select coalesce(
      (select quote_ident(n.nspname) || '.' || quote_ident(c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.oid = to_regclass(${table})),
      quote_ident(coalesce(${schema}, current_schema())) || '.' || quote_ident(${table.slice(dot + 1)})
    ) as journal`;

  if (found.journal === null) {
    throw new MigrationError(
      "table",
      `cannot create the journal ${table}: no schema of the search_path exists`,
    );
  }

  return found.journal;
}

/** Creates the journal, or checks that the table of its name is one. */
async function openJournal(
  connection: ReservedSQL,
  journal: string,
): Promise<void> {
  const [found] = await connection`select to_regclass(${journal})::oid as oid`;

  if (found.oid === null) {
    try {
      await connection.unsafe(
        `create table ${journal} (name text primary key, checksum text not null, applied_at timestamptz not null default now())`,
      );
    } catch (error) {
      throw new MigrationError(
        "table",
        `cannot create the journal ${journal}: ${messageOf(error)}`,
        { cause: error },
      );
    }

    return;
  }

  const columns: { column: string }[] = await connection`
    select attname || ' ' || format_type(atttypid, atttypmod) as column
    from pg_attribute
    where attrelid = ${found.oid} and attnum > 0 and not attisdropped
    order by attnum`;

  const shape = columns.map((row) => row.column);

  if (shape.join(", ") !== JOURNAL.join(", ")) {
    throw new MigrationError(
      "table",
      `${journal} exists and is not a migration journal: its columns are ${shape.join(", ")}, not ${JOURNAL.join(", ")}`,
    );
  }
}

/** The applied migrations, by name, with their checksums. */
async function appliedIn(
  connection: ReservedSQL,
  journal: string,
): Promise<Map<string, string>> {
  const rows: { name: string; checksum: string }[] = await connection.unsafe(
    `select name, checksum from ${journal}`,
  );

  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/** What the journal and the files leave to a run. */
interface Plan {
  /** The migrations to apply, in order. */
  readonly pending: readonly MigrationFile[];

  /** {@link MigrateResult.ahead}. */
  readonly ahead: readonly string[];
}

/**
 * What to apply, once the applied migrations check out: each still has its
 * file, unchanged, unless it is newer than every file, and nothing pending
 * is older than the last applied or empty. With no file at all there is
 * nothing to be newer than, and the directory is more likely the wrong one
 * than the code that old.
 */
function planOf(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
): Plan {
  const byName = new Map(files.map((file) => [file.name, file]));
  const names = [...applied.keys()].toSorted();
  const newest = files.at(-1)?.name;
  const ahead: string[] = [];

  for (const name of names) {
    const file = byName.get(name);

    if (file === undefined && newest !== undefined && name > newest) {
      ahead.push(name);
      continue;
    }

    if (file === undefined) {
      throw new MigrationError(
        "missing",
        newest === undefined
          ? `${name} was applied, and the directory holds no migration files: is it the right one?`
          : `${name} was applied, and its file is gone, though newer ones are there: restore it`,
        { migration: name },
      );
    }

    if (file.checksum !== applied.get(name)) {
      throw new MigrationError(
        "changed",
        `${name} was applied, and its file has changed since: write a new migration instead`,
        { migration: name },
      );
    }
  }

  const last = names.at(-1);
  const pending = files.filter((file) => !applied.has(file.name));

  for (const file of pending) {
    if (last !== undefined && file.name < last) {
      throw new MigrationError(
        "out-of-order",
        `${file.name} is older than the last applied migration, ${last}: rename it with a newer timestamp`,
        { migration: file.name },
      );
    }

    if (isEmpty(file.text)) {
      throw new MigrationError(
        "empty",
        `${file.name} is empty: write the migration, or delete the file`,
        {
          migration: file.name,
        },
      );
    }
  }

  return { pending, ahead };
}

/** What a run carries from one migration to the next. */
interface Run {
  /** {@link MigrateOptions.lockTimeoutMs}, checked. */
  readonly lockTimeoutMs: number;

  /** The migrations this run has applied so far. */
  readonly applied: readonly string[];
}

/**
 * Runs one migration and records it.
 *
 * In a transaction, the transaction's id is read before the file. A file
 * that commits or rolls back on its own ends that transaction: the id read
 * after the file differs, or, when the file then fails, the first
 * transaction shows as committed. Such a file is refused, not recorded.
 */
async function apply(
  connection: ReservedSQL,
  journal: string,
  file: MigrationFile,
  run: Run,
): Promise<void> {
  const record = `insert into ${journal} (name, checksum) values ($1, $2)`;
  let before: string | undefined;

  try {
    if (!file.transaction) {
      await liftTimeouts(connection, false);
      await connection.unsafe(file.text).simple();
      await connection.begin(async (tx) => {
        await tx.unsafe(RESET).simple();
        await tx.unsafe(record, [file.name, file.checksum]);
      });

      return;
    }

    await connection.begin(async (tx) => {
      const [start] = await tx`
        select pg_current_xact_id()::text as id,
               set_config('lock_timeout', ${`${run.lockTimeoutMs}ms`}, true)`;

      before = start.id;
      await tx.unsafe(file.text).simple();

      const [end] = await tx`select pg_current_xact_id()::text as id`;

      if (end.id !== before) {
        throw ownTransaction(file, run);
      }

      await tx.unsafe(RESET).simple();
      await tx.unsafe(record, [file.name, file.checksum]);
    });
  } catch (error) {
    if (error instanceof MigrationError) {
      throw error;
    }

    if (before !== undefined && (await committed(connection, before))) {
      throw ownTransaction(file, run, error);
    }

    throw new MigrationError(
      "failed",
      `${file.name} failed${lineOf(file.text, error)}: ${messageOf(error)}`,
      { migration: file.name, cause: error, applied: run.applied },
    );
  }
}

/** The refusal of a migration that ended the transaction it runs in. */
function ownTransaction(
  file: MigrationFile,
  run: Run,
  cause?: unknown,
): MigrationError {
  return new MigrationError(
    "own-transaction",
    `${file.name} commits or rolls back the transaction it runs in, so part of it may stay applied without being recorded: take its COMMIT or ROLLBACK out, or make its first line -- no-transaction`,
    { migration: file.name, cause, applied: run.applied },
  );
}

/**
 * Whether a transaction committed. When that cannot be read, the
 * connection is broken, and the migration's own error is the one to report.
 */
async function committed(
  connection: ReservedSQL,
  id: string,
): Promise<boolean> {
  try {
    const [row] =
      await connection`select pg_xact_status(${id}::xid8) as status`;

    return row.status === "committed";
  } catch {
    return false;
  }
}

/**
 * Where in a migration its error points, as ` at line N`, when Postgres
 * gives a position: the character the error is at, counted from 1.
 */
function lineOf(text: string, error: unknown): string {
  const { position } = error as { position?: unknown };

  if (typeof position !== "string") {
    return "";
  }

  const before = [...text].slice(0, Number(position) - 1);

  return ` at line ${before.filter((char) => char === "\n").length + 1}`;
}

/** What an error says, for the message of the error that wraps it. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
