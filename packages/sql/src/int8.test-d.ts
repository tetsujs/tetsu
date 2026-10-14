/**
 * Types generated with `int8: "string"`: an `int8` is selected as a
 * string, and written as a string, a number or a bigint, its arrays too;
 * Kysely compares it as it selects it, a string. A query file's `int8`
 * columns are strings, and its `int8` parameters, a `limit` among them,
 * take a number as well.
 *
 * @module
 */

import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type { DB } from "../test-utils/fixtures/int8/db.generated.ts";
import type {
  LedgerPageParams,
  LedgerPageRow,
} from "../test-utils/fixtures/int8/queries.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";

declare const db: Kysely<DB>;

type Ledger = DB["ledger"];

type Selected = Selectable<Ledger>;
type Inserted = Insertable<Ledger>;

export type columns = [
  Expect<Equal<Selected["id"], string>>,
  Expect<Equal<Selected["amount"], string>>,
  Expect<Equal<Selected["refs"], string[]>>,
  Expect<Equal<Inserted["amount"], string | number | bigint>>,
  Expect<
    Equal<Inserted["refs"], readonly (string | number | bigint)[] | undefined>
  >,
  Expect<
    Equal<Updateable<Ledger>["amount"], string | number | bigint | undefined>
  >,
];

export type queries = [
  Expect<Equal<LedgerPageRow, { id: string; amount: string; entries: string }>>,
  Expect<
    Equal<
      LedgerPageParams,
      { after: string | number | bigint; limit: string | number | bigint }
    >
  >,
];

export const written = db
  .insertInto("ledger")
  .values([
    { amount: "100" },
    { amount: 100 },
    { amount: 100n, refs: [1, 2n] },
  ]);

export const compared = db
  .selectFrom("ledger")
  .select("id")
  .where("id", "=", "42");

export const comparedToANumber = db
  .selectFrom("ledger")
  .select("id")
  // @ts-expect-error Kysely compares a column as it selects it: a string
  .where("id", "=", 42);
