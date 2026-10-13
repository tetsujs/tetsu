/**
 * A unit of work that holds together, whether it runs on its own or inside
 * another's transaction.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { SQL } from "bun";
import type {
  ControlledTransaction,
  Kysely,
  KyselyPlugin,
  Transaction,
} from "kysely";
import { sql } from "kysely";

/** A unit open inside a transaction, with its savepoint. */
type Unit = object;

/** How many savepoints `atomic` has named, to name the next one apart. */
let savepoints = 0;

/** The unit whose work runs, where it runs. */
const running = new AsyncLocalStorage<Unit>();

/**
 * The transaction a unit's own transaction object belongs to: the one
 * `atomic` was given, all the way up.
 */
const transactions = new WeakMap<object, object>();

/** The units open inside each transaction, innermost last. */
const stacks = new WeakMap<object, Unit[]>();

/**
 * What the transaction object a unit is handed carries over the one it was
 * given: nothing but being an object of its own, which the unit's own units
 * are told apart by.
 */
const OWN: KyselyPlugin = {
  transformQuery: (args) => args.node,
  transformResult: async (args) => args.result,
};

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
 * still open is refused before it writes anything. Queries of the
 * transaction that run beside a unit are not seen: await the unit.
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
  const transaction = transactions.get(trx) ?? trx;
  const stack = stacks.get(transaction) ?? [];
  const inside = stack.at(-1);

  if (inside !== undefined && inside !== running.getStore()) {
    throw new Error(
      "atomic() was called beside another unit of the same transaction that is still open: units of one transaction run one after another, or one inside another, never side by side, as with Promise.all",
    );
  }

  const unit: Unit = {};
  const own = trx.withPlugin(OWN);

  savepoints += 1;
  stack.push(unit);
  stacks.set(transaction, stack);
  transactions.set(own, transaction);

  const name = sql.id(`atomic_${savepoints}`);

  try {
    await sql`savepoint ${name}`.execute(trx);

    let result: T;

    try {
      result = await running.run(unit, () => work(own));
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
