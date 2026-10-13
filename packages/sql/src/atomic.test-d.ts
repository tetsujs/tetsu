/**
 * The types of `atomic()`: the work is handed a transaction of the same
 * database, whether `atomic` was given the database, a transaction or a
 * controlled one, and resolves to what the work returns.
 *
 * @module
 */

import type { ControlledTransaction, Kysely, Transaction } from "kysely";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import { atomic } from "./atomic.ts";

declare const db: Kysely<DB>;
declare const trx: Transaction<DB>;
declare const controlled: ControlledTransaction<DB>;
declare const either: Kysely<DB> | Transaction<DB>;

export const handedByDatabase = atomic(db, async (inner) => inner);
export const handedByTransaction = atomic(trx, async (inner) => inner);
export const handedByControlled = atomic(controlled, async (inner) => inner);
export const handedByEither = atomic(either, async (inner) => inner);

export const counted = atomic(db, async (inner) => {
  const rows = await inner.selectFrom("orders").select("id").execute();

  return rows.length;
});

export type handed = [
  Expect<Equal<Awaited<typeof handedByDatabase>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByTransaction>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByControlled>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByEither>, Transaction<DB>>>,
  Expect<Equal<typeof counted, Promise<number>>>,
];
