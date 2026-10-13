/**
 * The generated types, as Kysely reads them: what a column selects as,
 * what an insert and an update take, and the queries they let through or
 * refuse. The file is the one the fixture migrations generate.
 *
 * @module
 */

import type {
  Insertable,
  InsertType,
  Kysely,
  SelectType,
  UpdateType,
} from "kysely";
import type {
  Constraint,
  DB,
  Kind,
  OrderStatus,
  OrdersChannel,
  OrdersPriority,
  schema,
} from "../test-utils/fixtures/schema/db.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { Schema } from "./schema.ts";

type Orders = DB["orders"];

export type columns = [
  Expect<Equal<SelectType<Orders["id"]>, bigint>>,
  Expect<Equal<InsertType<Orders["id"]>, never>>,
  Expect<Equal<UpdateType<Orders["id"]>, never>>,
  Expect<Equal<SelectType<Orders["number"]>, number>>,
  Expect<Equal<InsertType<Orders["number"]>, number | undefined>>,
  Expect<Equal<SelectType<Orders["status"]>, OrderStatus>>,
  Expect<Equal<OrderStatus, "new" | "paid" | "shipped">>,
  Expect<Equal<SelectType<Orders["shipping"]>, "paid" | "shipped" | null>>,
  Expect<Equal<SelectType<Orders["kind"]>, Kind>>,
  Expect<Equal<Kind, "retail" | "bulk">>,
  Expect<Equal<OrdersChannel, "web" | "shop" | "it's" | 'say "hi"'>>,
  Expect<Equal<OrdersPriority, 1 | 2 | -3>>,
  Expect<Equal<SelectType<Orders["quantity"]>, number>>,
  Expect<Equal<SelectType<Orders["tags"]>, string[]>>,
  Expect<Equal<InsertType<Orders["tags"]>, readonly string[] | undefined>>,
  Expect<Equal<SelectType<Orders["notes"]>, (string | null)[] | null>>,
  Expect<Equal<InsertType<Orders["notes"]>, readonly (string | null)[] | null>>,
  Expect<Equal<SelectType<Orders["coupons"]>, string | null>>,
  Expect<Equal<InsertType<Orders["coupons"]>, readonly string[] | null>>,
  Expect<Equal<InsertType<Orders["history"]>, readonly OrderStatus[] | null>>,
  Expect<Equal<SelectType<Orders["amount"]>, string>>,
  Expect<Equal<SelectType<Orders["total"]>, string | null>>,
  Expect<Equal<InsertType<Orders["total"]>, never>>,
  Expect<Equal<SelectType<Orders["note"]>, string>>,
  Expect<Equal<SelectType<Orders["payload"]>, unknown>>,
  Expect<Equal<InsertType<Orders["payload"]>, object | undefined>>,
  Expect<Equal<SelectType<Orders["placed_on"]>, Date>>,
  Expect<Equal<InsertType<Orders["placed_on"]>, Date | string | undefined>>,
  Expect<Equal<UpdateType<Orders["placed_at"]>, Date | string>>,
  Expect<Equal<SelectType<Orders["receipt"]>, Buffer | null>>,
  Expect<Equal<SelectType<Orders["rank"]>, 10 | 20>>,
  Expect<Equal<SelectType<Orders["outer_kind"]>, "a" | "b">>,
  Expect<Equal<SelectType<Orders["inner_kind"]>, "a" | "b" | "c" | null>>,
  Expect<Equal<InsertType<Orders["pieces"]>, number | undefined>>,
  Expect<Equal<SelectType<Orders["tone"]>, string>>,
  Expect<Equal<SelectType<Orders["ci_kind"]>, "retail" | "bulk" | null>>,
  Expect<Equal<SelectType<Orders["required_attributes"]>, unknown>>,
  Expect<
    Equal<InsertType<Orders["required_attributes"]>, NonNullable<unknown>>
  >,
  Expect<Equal<SelectType<Orders["attributes"]>, unknown>>,
  Expect<Equal<InsertType<Orders["receipt"]>, Uint8Array | null>>,
];

export type relations = [
  Expect<Equal<SelectType<DB["open_orders"]["id"]>, bigint | null>>,
  Expect<Equal<SelectType<DB["order_counts"]["orders"]>, bigint | null>>,
  Expect<Equal<InsertType<DB["order_counts"]["orders"]>, never>>,
  Expect<Equal<keyof Insertable<DB["order_counts"]>, never>>,
  Expect<Equal<SelectType<DB["imported"]["code"]>, string | null>>,
  Expect<Equal<SelectType<DB["imported"]["kind"]>, string | null>>,
  Expect<Equal<SelectType<DB["imported"]["status"]>, OrderStatus | null>>,
  Expect<
    Equal<
      keyof DB["order_items"],
      "order_id" | "line" | "Mixed Case" | "select" | "2fa"
    >
  >,
  Expect<Equal<DB["empty"], Record<never, never>>>,
  Expect<
    Equal<
      SelectType<DB["billing.invoices"]["state"]>,
      "draft" | "sent" | "paid"
    >
  >,
  Expect<Equal<"events_2026" extends keyof DB ? true : false, false>>,
  Expect<Equal<"migrations" extends keyof DB ? true : false, false>>,
];

/** The keys of `T` an object must have. */
type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

export type insertable = [
  Expect<
    Equal<
      RequiredKeys<Insertable<Orders>>,
      | "kind"
      | "channel"
      | "quantity"
      | "amount"
      | "note"
      | "outer_kind"
      | "required_attributes"
    >
  >,
  Expect<Equal<"id" extends keyof Insertable<Orders> ? true : false, false>>,
  Expect<Equal<"total" extends keyof Insertable<Orders> ? true : false, false>>,
];

export type constraints = [
  Expect<
    Equal<"orders_open_email_key" extends Constraint ? true : false, true>
  >,
  Expect<Equal<"kind_check" extends Constraint ? true : false, true>>,
  Expect<Equal<"migrations_pkey" extends Constraint ? true : false, false>>,
  Expect<Equal<"imported_kind_check" extends Constraint ? true : false, false>>,
  Expect<Equal<typeof schema, Schema<DB, Constraint>>>,
];

declare const db: Kysely<DB>;

const required = {
  kind: "retail",
  channel: "web",
  quantity: 1,
  amount: "12.50",
  note: "fragile",
  outer_kind: "a",
  required_attributes: "colour=>red",
} as const;

const stringified: Insertable<Orders> = {
  ...required,
  // @ts-expect-error a string would be stored as a JSON string
  payload: JSON.stringify({ lines: [] }),
};

const unlisted: Insertable<Orders> = {
  ...required,
  // @ts-expect-error a check allows the channel only its list
  channel: "phone",
};

export const queries = [
  db
    .selectFrom("orders")
    .select(["status", "tags", "coupons"])
    .where("status", "=", "paid"),
  db.insertInto("orders").values({
    ...required,
    payload: { lines: [] },
    tags: ["gift"],
    placed_on: "2026-10-12",
  }),
  db.insertInto("orders").values(stringified),
  db.insertInto("orders").values({
    ...required,
    // @ts-expect-error an identity always is never written
    id: 1n,
  }),
  db.insertInto("orders").values(unlisted),
  db
    .selectFrom("orders")
    .select("status")
    // @ts-expect-error an enum is only its labels
    .where("status", "=", "lost"),
  db
    .updateTable("orders")
    // @ts-expect-error a generated column is never written
    .set({ total: "1.00" }),
];
