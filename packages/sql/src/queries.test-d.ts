/**
 * The functions of the fixture's query files, as TypeScript types them: a
 * column taken from a table is typed as Kysely selects that column, made
 * NULL by a join that may find no row; a parameter is typed as its type is
 * written; and a function takes a transaction as well as the database,
 * as `queryRows` and `queryCount` do, called on their own.
 *
 * @module
 */

import type {
  ControlledTransaction,
  Kysely,
  SelectType,
  Transaction,
} from "kysely";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import type {
  InsertOrderParams,
  InvoicesAndOrdersRow,
  OrderByIdRow,
  OrdersWithItemsParams,
  OrdersWithItemsRow,
} from "../test-utils/fixtures/schema/queries.generated.ts";
import {
  documents,
  insertOrder,
  now,
  orderById,
  shipOrder,
} from "../test-utils/fixtures/schema/queries.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { FileQuery } from "./queries.ts";
import { queryCount, queryRows } from "./queries.ts";

declare const db: Kysely<DB>;
declare const trx: Transaction<DB>;
declare const controlled: ControlledTransaction<DB>;
declare const query: FileQuery;

type Orders = DB["orders"];

/** What Kysely selects a column of `orders` as. */
type Selected<K extends keyof Orders> = SelectType<Orders[K]>;

/** What Kysely selects these columns of `orders` as. */
type SelectedColumns<K extends keyof Orders> = {
  [P in K]: Selected<P>;
};

export type rows = [
  Expect<Equal<Exclude<keyof OrderByIdRow, keyof Orders>, never>>,
  Expect<
    Equal<OrderByIdRow, SelectedColumns<keyof OrderByIdRow & keyof Orders>>
  >,
  Expect<Equal<OrdersWithItemsRow["status"], Selected<"status">>>,
  Expect<
    Equal<
      OrdersWithItemsRow["line"],
      SelectType<DB["order_items"]["line"]> | null
    >
  >,
  Expect<Equal<OrdersWithItemsRow["total"], bigint>>,
  Expect<Equal<InvoicesAndOrdersRow["order"], bigint | null>>,
];

export type parameters = [
  Expect<
    Equal<OrdersWithItemsParams["statuses"], readonly Selected<"status">[]>
  >,
  Expect<Equal<OrdersWithItemsParams["note"], string | null>>,
  Expect<Equal<InsertOrderParams["placedAt"], Date | string>>,
  Expect<Equal<InsertOrderParams["payload"], object>>,
  Expect<Equal<InsertOrderParams["tags"], readonly string[]>>,
];

export const returned = [
  orderById(db, { id: 1n }),
  orderById(trx, { id: 1n }),
  shipOrder(db, { id: 1n }),
  orderById(controlled, { id: 1n }),
  now(db),
] as const;

export type results = [
  Expect<Equal<(typeof returned)[0], Promise<OrderByIdRow[]>>>,
  Expect<Equal<(typeof returned)[2], Promise<bigint>>>,
];

// @ts-expect-error an int8 is a bigint, not a number
export const wrongType = orderById(db, { id: 1 });

// @ts-expect-error a parameter that is not marked ? is not NULL
export const nullParameter = orderById(db, { id: null });

// @ts-expect-error every parameter is given
export const missingParameter = insertOrder(db, { kind: "bulk" });

// @ts-expect-error a parameter of jsonb is an object or an array, not a string
export const stringDocument = documents(db, { documents: ['{"a": 1}'] });

// @ts-expect-error a function of no parameters takes none
export const extraParameters = now(db, {});

export const element = documents(db, { documents: [{ a: 1 }, [1], null] });

export const onTheirOwn = [
  queryRows(trx, query, { id: 1n }),
  queryCount(trx, query, { id: 1n }),
  queryCount(controlled, query),
  queryRows<{ id: bigint }>(db, query),
] as const;

// @ts-expect-error a query of a file runs on what can execute it
export const notKysely = queryRows({}, query);

export type ofTheirOwn = [
  Expect<Equal<(typeof onTheirOwn)[0], Promise<unknown[]>>>,
  Expect<Equal<(typeof onTheirOwn)[1], Promise<bigint>>>,
  Expect<Equal<(typeof onTheirOwn)[3], Promise<{ id: bigint }[]>>>,
];
