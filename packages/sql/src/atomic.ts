/**
 * A unit of work that holds together, whether it runs on its own or inside
 * another's transaction.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import type { ControlledTransaction, Kysely, Transaction } from "kysely";
import { sql } from "kysely";

/** A unit open inside a transaction, with its savepoint. */
type Unit = object;

/** How many savepoints `atomic` has named, to name the next one apart. */
let savepoints = 0;

/** The unit whose work runs, where it runs. */
const running = new AsyncLocalStorage<Unit>();

/**
 * The units open inside each transaction, innermost last, by the
 * connection it runs on: the one object every Kysely of the transaction
 * shares, those `withSchema()`, `withPlugin()` and `withTables()` make of
 * it and a controlled transaction's savepoints included, each an object of
 * its own. The driver makes a connection object for each transaction.
 */
const stacks = new WeakMap<object, Unit[]>();

/** The connection a transaction runs on, as its executor hands it out. */
function connectionOf(trx: Transaction<unknown>): Promise<object> {
  return trx.getExecutor().provideConnection(async (connection) => connection);
}

/**
 * Runs `work` as one unit: all it writes is kept, or none of it.
 *
 * Outside a transaction it opens one, which commits when `work` resolves
 * and rolls back when it throws. Inside one — a `Transaction` a caller
 * passed on — it marks a savepoint instead: `work` throwing undoes what it
 * wrote, and nothing the transaction wrote before, which goes on. So a
 * method of a service written with `atomic` is atomic called on its own
 * and inside another's transaction, which Kysely's `transaction()` refuses
 * to be.
 *
 * A query of `work` that fails aborts the transaction, though `work`
 * catches the failure: on its own the commit then fails, and inside a
 * transaction the savepoint is rolled back and fails the same way, with
 * Bun's `ERR_POSTGRES_COMMIT_ROLLED_BACK`.
 *
 * Units inside one transaction run one after another, or one inside
 * another, never side by side, as with `Promise.all`: rolling one back
 * would undo what the other wrote. A unit opened beside another that is
 * still open is refused before it writes anything, whichever Kysely of the
 * transaction each was given: the transaction, or one `withSchema()`,
 * `withPlugin()` or `withTables()` made of it. Queries of the transaction
 * that run beside a unit are not seen: await the unit.
 *
 * @example
 * ```ts
 * function reserve(db: Kysely<DB>, order: bigint) {
 *   return atomic(db, async (trx) => {
 *     await trx.updateTable("stock").set(...).execute();
 *     await trx.insertInto("reservations").values(...).execute();
 *   });
 * }
 * ```
 *
 * @throws {Error} when another unit of the same transaction is open beside
 * it.
 */
export async function atomic<DB, T>(
  executor: Kysely<DB> | Transaction<DB> | ControlledTransaction<DB>,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!executor.isTransaction) {
    return await executor.transaction().execute(work);
  }

  const trx = executor as Transaction<DB>;
  const connection = await connectionOf(trx as Transaction<unknown>);
  const stack = stacks.get(connection) ?? [];
  const inside = stack.at(-1);

  if (inside !== undefined && inside !== running.getStore()) {
    throw new Error(
      "atomic() was called beside another unit of the same transaction that is still open: units of one transaction run one after another, or one inside another, never side by side, as with Promise.all",
    );
  }

  const unit: Unit = {};

  savepoints += 1;
  stack.push(unit);
  stacks.set(connection, stack);

  const name = sql.id(`atomic_${savepoints}`);

  try {
    await sql`savepoint ${name}`.execute(trx);

    let result: T;

    try {
      result = await running.run(unit, () => work(trx));
    } catch (error) {
      await sql`rollback to savepoint ${name}; release savepoint ${name}`
        .execute(trx)
        .catch(() => undefined);

      throw error;
    }

    try {
      await sql`release savepoint ${name}`.execute(trx);
    } catch (error) {
      if ((error as { errno?: unknown }).errno !== "25P02") {
        throw error;
      }

      await sql`rollback to savepoint ${name}; release savepoint ${name}`.execute(
        trx,
      );

      throw new SQL.PostgresError(
        "RELEASE SAVEPOINT was refused because the transaction was already aborted: the savepoint was rolled back",
        { code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" },
      );
    }

    return result;
  } finally {
    stack.pop();
  }
}
