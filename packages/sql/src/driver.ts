/**
 * Kysely's dialect on Bun.SQL: the driver `database()` builds its `Kysely`
 * on.
 *
 * A query runs on a connection reserved from Bun's pool, and its values go
 * through as Bun binds and reads them, but for three, which it makes what
 * the generated types say. A `Date` is bound as its ISO text, which a
 * `date` reads as well as a timestamp. An `Int32Array` or a `Float32Array`,
 * which Bun reads an `int4[]` or a `float4[]` as when a query has
 * parameters, is read as an array, as it is without them. And a commit
 * that Postgres turns into a rollback, as it does when a query of the
 * transaction failed and the failure was caught, fails as Bun's own
 * `sql.begin()` does, rather than resolve with nothing written.
 *
 * @module
 */

import type { ReservedSQL } from "bun";
import { SQL } from "bun";
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from "kysely";
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { isoOf } from "./values.ts";

/** What Bun hands back for a query: its rows, and what it did. */
interface Result extends ReadonlyArray<Record<string, unknown>> {
  /** The command's tag, such as `INSERT` or `ROLLBACK`. */
  readonly command?: string;

  /** How many rows the command returned or changed. */
  readonly count?: number;
}

/** The commands whose count is of the rows they changed. */
const CHANGES: ReadonlySet<string> = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
]);

/**
 * Kysely's dialect on a Bun.SQL client of Postgres, the pool, and a client
 * of the same database beside it, of one connection, that cancels a query
 * of the pool's. The cancel cannot wait for a connection of the pool: the
 * one the query holds is handed back only once the cancel is sent, and a
 * transaction's is the very connection to cancel.
 */
export class BunDialect implements Dialect {
  private readonly sql: SQL;
  private readonly control: SQL;

  constructor(sql: SQL, control: SQL) {
    this.sql = sql;
    this.control = control;
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new BunDriver(this.sql, this.control);
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
}

/**
 * The driver: a connection is one reserved from the pool, and a
 * transaction is opened and ended with plain statements on it, as Kysely's
 * own driver for Postgres does.
 *
 * A wait for a connection is not given the signal of a query: Kysely stops
 * waiting itself, and hands back a connection that comes after, while a
 * reservation Bun gave up would have Kysely print the failure.
 */
class BunDriver implements Driver {
  private readonly sql: SQL;
  private readonly control: SQL;

  constructor(sql: SQL, control: SQL) {
    this.sql = sql;
    this.control = control;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new BunConnection(await this.sql.reserve(), this.control);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const { isolationLevel, accessMode } = settings;
    const statement =
      isolationLevel === undefined && accessMode === undefined
        ? "begin"
        : [
            "start transaction",
            ...(isolationLevel === undefined
              ? []
              : [`isolation level ${isolationLevel}`]),
            ...(accessMode === undefined ? [] : [accessMode]),
          ].join(" ");

    await run(connection, statement);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await (connection as BunConnection).commit();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await run(connection, "rollback");
  }

  async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
    await run(connection, `savepoint ${identifier(name)}`);
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    name: string,
  ): Promise<void> {
    await run(connection, `rollback to savepoint ${identifier(name)}`);
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    name: string,
  ): Promise<void> {
    await run(connection, `release savepoint ${identifier(name)}`);
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as BunConnection).release();
  }

  async destroy(): Promise<void> {
    await Promise.all([this.sql.close(), this.control.close()]);
  }
}

/**
 * A connection reserved from the pool. A query it runs can be cancelled,
 * by the process id of its backend, from the client of the dialect's that
 * cancels; a session is never killed, since Bun's pool may then wait
 * forever to close.
 */
class BunConnection implements DatabaseConnection {
  private readonly reserved: ReservedSQL;
  private readonly control: SQL;

  /** The process id of its backend, once a query that may be cancelled asked. */
  private pid: number | undefined;

  /** The query it runs, which a cancel is meant for. */
  private running: CompiledQuery | undefined;

  constructor(reserved: ReservedSQL, control: SQL) {
    this.reserved = reserved;
    this.control = control;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this.running = compiledQuery;

    try {
      const result = lastOf(
        await this.reserved.unsafe(
          compiledQuery.sql,
          compiledQuery.parameters.map(bindable),
        ),
      );
      const { command, count } = result;

      return {
        rows: rowsOf(result) as R[],
        ...(command !== undefined && CHANGES.has(command)
          ? { numAffectedRows: BigInt(count ?? 0) }
          : {}),
      };
    } finally {
      this.running = undefined;
    }
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error(
      "stream() reads rows through a cursor, which Bun.SQL does not have yet: use execute()",
    );
  }

  async collectSessionInfo(): Promise<void> {
    if (this.pid === undefined) {
      const [row] = await this.reserved.unsafe(
        "select pg_backend_pid() as pid",
      );

      this.pid = row.pid;
    }
  }

  /**
   * Cancels the query it runs, unless that one has ended by the time the
   * client that cancels has a connection to send the cancel on.
   */
  async cancelQuery(): Promise<void> {
    const { pid, running } = this;

    if (pid === undefined || running === undefined) {
      return;
    }

    const control = await this.control.reserve();

    try {
      if (this.running === running) {
        await control.unsafe("select pg_cancel_backend($1)", [pid]);
      }
    } finally {
      control.release();
    }
  }

  /**
   * Commits. Postgres answers a commit of a transaction that failed by
   * rolling it back, without an error, so that answer fails here.
   */
  async commit(): Promise<void> {
    const result: Result = await this.reserved.unsafe("commit");

    if (result.command === "ROLLBACK") {
      throw new SQL.PostgresError(
        "COMMIT was rolled back by the server because the transaction was already aborted",
        { code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" },
      );
    }
  }

  /** Hands the connection back to the pool. */
  release(): void {
    this.reserved.release();
  }
}

/** Runs one statement of the driver's own on a connection. */
async function run(
  connection: DatabaseConnection,
  statement: string,
): Promise<void> {
  await connection.executeQuery(CompiledQuery.raw(statement));
}

/** A name quoted as Postgres reads an identifier. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The result of the last statement of a query. Bun hands back a query
 * without parameters that holds several statements, as raw SQL may, as the
 * list of their results.
 */
function lastOf(result: Result): Result {
  const last: unknown = result.at(-1);

  return result.command === undefined && Array.isArray(last)
    ? (last as Result)
    : result;
}

/** A parameter as Bun binds it right: a `Date` as its ISO text. */
function bindable(value: unknown): unknown {
  return value instanceof Date ? isoOf(value) : value;
}

/**
 * The rows of a result, each `Int32Array` or `Float32Array` in them made
 * an array. The rows are Bun's own, made for this query, and changed in
 * place.
 */
function rowsOf(result: Result): Record<string, unknown>[] {
  for (const row of result) {
    for (const key in row) {
      const value = row[key];

      if (value instanceof Int32Array || value instanceof Float32Array) {
        row[key] = Array.from(value);
      }
    }
  }

  return Array.from(result);
}
