/**
 * The types of `atomic()`: the work is handed a transaction of the same
 * database, whether `atomic` was given the database, a transaction or a
 * controlled one, one inside another, one with more tables, one typed by a
 * type parameter or `this` of a subclass, and resolves to what the work
 * returns; and nothing but a Kysely is taken.
 *
 * @module
 */

import type { ControlledTransaction, Dialect, Transaction } from "kysely";
import { Kysely } from "kysely";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import { atomic } from "./atomic.ts";

declare const db: Kysely<DB>;
declare const trx: Transaction<DB>;
declare const controlled: ControlledTransaction<DB>;
declare const either: Kysely<DB> | Transaction<DB>;
declare const savepointed: ControlledTransaction<DB, ["before"]>;
declare const dialect: Dialect;

export const handedByDatabase = atomic(db, async (inner) => inner);
export const handedByTransaction = atomic(trx, async (inner) => inner);
export const handedByControlled = atomic(controlled, async (inner) => inner);
export const handedByEither = atomic(either, async (inner) => inner);
export const handedBySavepointed = atomic(savepointed, async (inner) => inner);

export const counted = atomic(db, async (inner) => {
  const rows = await inner.selectFrom("orders").select("id").execute();

  return rows.length;
});

export const nested = atomic(db, async (outer) =>
  atomic(outer, async (inner) => inner),
);

export const widened = atomic(
  db.$extendTables<{ extras: { id: number } }>(),
  async (inner) => inner.selectFrom("extras").select("id").execute(),
);

export const unknownTable = atomic(db, async (inner) =>
  // @ts-expect-error the work is typed by the database: a table it lacks is refused
  inner.selectFrom("nowhere"),
);

// @ts-expect-error a unit runs on a Kysely
export const notKysely = atomic({}, async (inner) => inner);

/** A unit given a Kysely typed by a type parameter. */
export function ofParameter<E extends Kysely<DB>>(executor: E) {
  return atomic(executor, async (inner) =>
    inner.selectFrom("orders").select("id").execute(),
  );
}

/** A unit given `this`, in a subclass of Kysely. */
export class Orders extends Kysely<DB> {
  constructor() {
    super({ dialect });
  }

  ids() {
    return atomic(this, async (inner) =>
      inner.selectFrom("orders").select("id").execute(),
    );
  }
}

export type handed = [
  Expect<Equal<Awaited<typeof handedByDatabase>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByTransaction>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByControlled>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedByEither>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof handedBySavepointed>, Transaction<DB>>>,
  Expect<Equal<typeof counted, Promise<number>>>,
  Expect<Equal<Awaited<typeof nested>, Transaction<DB>>>,
  Expect<Equal<Awaited<typeof widened>, { id: number }[]>>,
  Expect<
    Equal<Awaited<ReturnType<typeof ofParameter<Kysely<DB>>>>, { id: bigint }[]>
  >,
  Expect<Equal<Awaited<ReturnType<Orders["ids"]>>, { id: bigint }[]>>,
];
