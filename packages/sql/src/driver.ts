/**
 * Kysely's dialect on Bun.SQL: the driver `database()` builds its `Kysely`
 * on.
 *
 * A query runs on Bun's pool, which sends the queries of many callers down
 * one connection without waiting for each answer, so that a query holds no
 * connection of its own. A connection is reserved where one is needed: for
 * a transaction, from its `begin`; for a query that may be cancelled, to
 * cancel it by; and for the work of `connection()`, whose queries share a
 * session, which {@link onOneConnection} marks. Reservations take turns at
 * the pool's connections but one, when it has more than one, so that one is
 * always left to the queries of the pool.
 *
 * Values go through as Bun binds and reads them, but for three, which it
 * makes what the generated types say. A `Date` is bound as its ISO text,
 * which a `date` reads as well as a timestamp. An `Int32Array` or a
 * `Float32Array`, which Bun reads an `int4[]` or a `float4[]` as when a
 * query has parameters, is read as an array, as it is without them. And a
 * commit that Postgres turns into a rollback, as it does when a query of
 * the transaction failed and the failure was caught, fails as Bun's own
 * `sql.begin()` does, rather than resolve with nothing written.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ReservedSQL } from "bun";
import { SQL } from "bun";
import type {
  AbortableOperationOptions,
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
 * Marks the work of `connection()`, whose queries share a session. The
 * first connection Kysely acquires in it is the one it hands the work, and
 * is reserved at once; a query the work runs on another Kysely, as on `db`
 * itself, still runs on the pool.
 */
const ONE_CONNECTION = new AsyncLocalStorage<{ taken: boolean }>();

/**
 * Runs `work`, the work of `connection()`, with the first connection
 * Kysely acquires in it reserved for it.
 */
export function onOneConnection<T>(work: () => T): T {
  return ONE_CONNECTION.run({ taken: false }, work);
}

/**
 * Turns at the pool's connections, for reservations, handed out in the
 * order they are asked for.
 */
class Turns {
  private free: number;

  /** What waits for a turn, the first asked first. */
  private readonly waiting: (() => void)[] = [];

  constructor(count: number) {
    this.free = count;
  }

  /** Takes a turn, once one is free for it. */
  async take(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;

      return;
    }

    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /** Hands a turn back, to the first that waits for one. */
  give(): void {
    const next = this.waiting.shift();

    if (next === undefined) {
      this.free += 1;
    } else {
      next();
    }
  }
}

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
 * The driver: a connection is the pool until it reserves one of its own,
 * and a transaction is opened and ended with plain statements on that one,
 * as Kysely's own driver for Postgres does.
 *
 * Reservations take turns at one fewer connection than the pool holds, at
 * least one. Bun hands a connection that comes free to a reservation that
 * waits before a query of the pool, so that, were every connection for
 * reservations to take, a query of the pool would wait for as long as
 * they kept coming.
 *
 * A transaction whose `begin` or `rollback` fails closes its connection
 * and hands its turn back at once. Neither fails on a sound connection,
 * Kysely hands back neither connection of a transaction it controls, and
 * one handed back to the pool in that state could hold a transaction
 * open; Bun opens another in its place. So does a transaction whose
 * `commit` failed on a connection that no longer answers: on one that
 * does, as when Postgres turned the commit into a rollback, the rollback
 * Kysely asks for after a failed commit still runs on it.
 *
 * A wait for a reservation is not given the signal of a query: Kysely
 * stops waiting itself, and hands back a connection that comes after,
 * while a reservation Bun gave up would have Kysely print the failure.
 */
class BunDriver implements Driver {
  private readonly sql: SQL;
  private readonly control: SQL;
  private readonly turns: Turns;

  constructor(sql: SQL, control: SQL) {
    this.sql = sql;
    this.control = control;
    this.turns = new Turns(Math.max(1, (sql.options.max ?? 10) - 1));
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const connection = new BunConnection(this.sql, this.control, this.turns);
    const mark = ONE_CONNECTION.getStore();

    if (mark !== undefined && !mark.taken) {
      mark.taken = true;
      await connection.reserve();
    }

    return connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const own = connection as BunConnection;

    await own.reserve();

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

    try {
      await run(connection, statement);
    } catch (error) {
      await own.discard();

      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const own = connection as BunConnection;

    try {
      await own.commit();
    } catch (error) {
      if (!(await own.answers())) {
        await own.discard();
      }

      throw error;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    try {
      await run(connection, "rollback");
    } catch (error) {
      await (connection as BunConnection).discard();

      throw error;
    }
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
 * A connection, as Kysely acquires one: the pool, until it reserves a
 * connection of its own, for a transaction, a query that may be cancelled
 * or a session, which it hands back on release. A query it runs on its own
 * connection can be cancelled, by the process id of its backend, from the
 * client of the dialect's that cancels; a session is never killed, since
 * Bun's pool may then wait forever to close.
 *
 * A query given a signal that is aborted while the query waits in Bun's
 * queue for a connection is taken out of the queue, as Kysely never runs
 * a query given up before it had a connection; one already sent runs to
 * its end, as Kysely's `ignore query` says.
 */
class BunConnection implements DatabaseConnection {
  private readonly pool: SQL;
  private readonly control: SQL;

  /**
   * The connection of its own, once it reserved one. It is kept once it is
   * handed back or closed, so that what still runs on it fails as on a
   * closed connection, rather than run on the pool.
   */
  private reserved: ReservedSQL | undefined;

  /** Whether its own connection, and its turn, went back. */
  private ended = false;

  /** The process id of its backend, once a query that may be cancelled asked. */
  private pid: number | undefined;

  /** The query it runs, which a cancel is meant for. */
  private running: CompiledQuery | undefined;

  /** The driver's turns at the pool's connections. */
  private readonly turns: Turns;

  constructor(pool: SQL, control: SQL, turns: Turns) {
    this.pool = pool;
    this.control = control;
    this.turns = turns;
  }

  /** Reserves a connection of its own on its turn, unless it has one. */
  async reserve(): Promise<ReservedSQL> {
    if (this.reserved === undefined) {
      await this.turns.take();

      try {
        this.reserved = await this.pool.reserve();
      } catch (error) {
        this.turns.give();

        throw error;
      }
    }

    return this.reserved;
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: AbortableOperationOptions,
  ): Promise<QueryResult<R>> {
    const query = (this.reserved ?? this.pool).unsafe(
      compiledQuery.sql,
      compiledQuery.parameters.map(bindable),
    );
    const signal = options?.signal;
    const drop = () => {
      query.cancel();
    };

    this.running = compiledQuery;
    signal?.addEventListener("abort", drop, { once: true });

    try {
      const result = lastOf(await query);
      const { command, count } = result;

      return {
        rows: rowsOf(result) as R[],
        ...(command !== undefined && CHANGES.has(command)
          ? { numAffectedRows: BigInt(count ?? 0) }
          : {}),
      };
    } catch (error) {
      if (signal?.aborted === true && isDropped(error)) {
        return { rows: [] };
      }

      throw error;
    } finally {
      signal?.removeEventListener("abort", drop);
      this.running = undefined;
    }
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error(
      "stream() reads rows through a cursor, which Bun.SQL does not have yet: use execute()",
    );
  }

  /**
   * Reserves the connection a query that may be cancelled runs on, and
   * learns the process id of its backend, which the cancel names.
   */
  async collectSessionInfo(): Promise<void> {
    const reserved = await this.reserve();

    if (this.pid === undefined) {
      const [row] = await reserved.unsafe("select pg_backend_pid() as pid");

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
    const result: Result = await (await this.reserve()).unsafe("commit");

    if (result.command === "ROLLBACK") {
      throw new SQL.PostgresError(
        "COMMIT was rolled back by the server because the transaction was already aborted",
        { code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" },
      );
    }
  }

  /** Whether its own connection still answers a query. */
  async answers(): Promise<boolean> {
    try {
      await (await this.reserve()).unsafe("select 1");

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hands its own connection back to the pool, and its turn, when it
   * reserved one, unless they went back already.
   */
  release(): void {
    if (this.reserved !== undefined && !this.ended) {
      this.ended = true;
      this.reserved.release();
      this.turns.give();
    }
  }

  /**
   * Closes its own connection, rather than hand it back, and then hands its
   * turn back, unless they went back already: a connection whose `begin` or
   * `rollback` failed is broken, or in a state nothing else should run in.
   * The close is the end of a connection that failed already, and fails
   * nothing more.
   */
  async discard(): Promise<void> {
    if (this.reserved !== undefined && !this.ended) {
      this.ended = true;
      await this.reserved.close().catch(() => undefined);
      this.turns.give();
    }
  }
}

/** Runs one statement of the driver's own on a connection. */
async function run(
  connection: DatabaseConnection,
  statement: string,
): Promise<void> {
  await connection.executeQuery(CompiledQuery.raw(statement));
}

/**
 * Whether `error` is Bun's answer for a query taken out of its queue
 * before it was sent: Kysely has already failed the query with its
 * signal's reason, and would print this one as a failure.
 */
function isDropped(error: unknown): boolean {
  return (
    error instanceof SQL.PostgresError &&
    error.code === "ERR_POSTGRES_QUERY_CANCELLED"
  );
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
