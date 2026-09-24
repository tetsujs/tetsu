/**
 * Lifecycle hooks: what runs around a handler, and what it adds to `ctx`.
 *
 * - `authenticate` runs before the body is read, refuses with `401`, and
 *   contributes `user` — typed in everything after it;
 * - `loadOrder` declares what it needs with `Requires`, so mounting it on a
 *   route with no `authenticate` in front is a compile error;
 * - `log` observes the finished response;
 * - `conflicts` maps an error of the domain to a response.
 *
 * ```sh
 * bun examples/hooks.ts
 * curl localhost:3000/orders/1                               # 401
 * curl -H 'authorization: Bearer ada' localhost:3000/orders/1
 * curl -H 'authorization: Bearer ada' localhost:3000/orders/2   # 404, not hers
 * curl -X POST -H 'authorization: Bearer ada' localhost:3000/orders/1/cancel
 * curl -X POST -H 'authorization: Bearer ada' localhost:3000/orders/1/cancel  # 409
 * ```
 *
 * @module
 */

import type { Requires } from "@tetsujs/core";
import { controller, createApp, HttpError, hook, route } from "@tetsujs/core";
import { z } from "zod";

interface User {
  readonly id: string;
}

interface Order {
  readonly id: number;
  readonly owner: string;
  status: "open" | "cancelled";
}

class AlreadyCancelled extends Error {}

const orders = new Map<number, Order>([
  [1, { id: 1, owner: "ada", status: "open" }],
  [2, { id: 2, owner: "grace", status: "open" }],
]);

const authenticate = hook.beforeParse((ctx) => {
  const token = ctx.req.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HttpError(401);
  }

  const user: User = { id: token };

  return { user };
});

const loadOrder = hook.beforeHandle(
  (ctx: Requires<{ user: User; params: { id: number } }>) => {
    const order = orders.get(ctx.params.id);

    if (!order || order.owner !== ctx.user.id) {
      throw new HttpError(404);
    }

    return { order };
  },
);

const log = hook.afterResponse((ctx) => {
  console.log(`${ctx.req.method} ${ctx.route?.path} → ${ctx.res.status}`);
});

const conflicts = hook.onError((ctx) =>
  ctx.error instanceof AlreadyCancelled
    ? Response.json({ error: "ALREADY_CANCELLED" }, { status: 409 })
    : undefined,
);

const OrderId = z.object({ id: z.coerce.number().int().positive() });

const ordersController = controller("Orders", () => ({
  get: route({
    method: "GET",
    path: "/orders/:id",
    schema: { params: OrderId },
    hooks: { beforeParse: [authenticate], beforeHandle: [loadOrder] },
    handler: (ctx) => ctx.order,
  }),

  cancel: route({
    method: "POST",
    path: "/orders/:id/cancel",
    schema: { params: OrderId },
    hooks: {
      beforeParse: [authenticate],
      beforeHandle: [loadOrder],
      onError: [conflicts],
    },
    handler: (ctx) => {
      if (ctx.order.status === "cancelled") {
        throw new AlreadyCancelled();
      }

      ctx.order.status = "cancelled";

      return ctx.order;
    },
  }),
}));

export default createApp({
  hooks: { afterResponse: [log] },
  routes: ordersController(),
});
