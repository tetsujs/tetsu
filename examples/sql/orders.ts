/**
 * Orders on Postgres, through `@tetsujs/sql`. The controller takes the
 * database as its dependency, reads with a function generated from a
 * query file, writes with Kysely's builder, and ships an order as one unit
 * of work.
 *
 * `db.generated.ts` and `queries.generated.ts` are generated from
 * `migrations/` and `queries/` by `tetsu-sql types:generate`; `main.ts`
 * serves the controller.
 *
 * @module
 */

import { controller, httpError, route } from "@tetsujs/core";
import { atomic, isViolation } from "@tetsujs/sql";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "./db.generated.ts";
import { customerOrders, shipOrder } from "./queries.generated.ts";

/**
 * An id in a path: an `int8`, which the database reads as a `bigint`, up to
 * the largest one Postgres takes.
 */
const Id = z.object({
  id: z.coerce.bigint().positive().max(9_223_372_036_854_775_807n),
});

const NewOrder = z.object({
  total: z.string().regex(/^\d+(\.\d{1,2})?$/),
  tags: z.array(z.string()).default([]),
  note: z.string().nullable().default(null),
});

const Shipment = z.object({ carrier: z.string().min(1) });

export const ordersController = controller("Orders", (db: Kysely<DB>) => ({
  list: route({
    method: "GET",
    path: "/customers/:id/orders",
    schema: { params: Id },
    handler: async (ctx) => {
      const orders = await customerOrders(db, { customerId: ctx.params.id });

      return orders.map((order) => ({ ...order, id: String(order.id) }));
    },
  }),

  create: route({
    method: "POST",
    path: "/customers/:id/orders",
    schema: { params: Id, body: NewOrder },
    handler: async (ctx) => {
      try {
        const { id } = await db
          .insertInto("orders")
          .values({ customer_id: ctx.params.id, ...ctx.body })
          .returning("id")
          .executeTakeFirstOrThrow();

        ctx.out.status = 201;

        return { id: String(id) };
      } catch (error) {
        if (isViolation(error, "orders_customer_id_fkey")) {
          throw httpError(404, "CUSTOMER_NOT_FOUND");
        }

        throw error;
      }
    },
  }),

  ship: route({
    method: "POST",
    path: "/orders/:id/shipment",
    schema: { params: Id, body: Shipment },
    handler: (ctx) =>
      atomic(db, async (trx) => {
        if ((await shipOrder(trx, { id: ctx.params.id })) === 0n) {
          throw httpError(409, "NOT_SHIPPABLE", "only a paid order ships");
        }

        await trx
          .insertInto("shipments")
          .values({ order_id: ctx.params.id, carrier: ctx.body.carrier })
          .execute();

        return { shipped: true };
      }),
  }),
}));
