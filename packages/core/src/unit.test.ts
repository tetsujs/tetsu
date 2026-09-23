/**
 * Unit tests: controllers called directly, with no server and no pipeline.
 *
 * This is the other half of the testing story — a controller is a plain
 * class and a route keeps its handler typed, so a handler can be called
 * with a context built by hand.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { testCtx } from "../test-utils/ctx.ts";
import type { Requires } from "./context.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

interface Order {
  id: string;
  status: "active" | "cancelled";
}

class OrderService {
  private orders = new Map<string, Order>([
    ["1", { id: "1", status: "active" }],
  ]);

  cancel(order: Order): Order {
    const cancelled: Order = { ...order, status: "cancelled" };

    this.orders.set(order.id, cancelled);

    return cancelled;
  }

  find(id: string): Order | undefined {
    return this.orders.get(id);
  }
}

const withOrder = hook.beforeHandle(
  (ctx: Requires<{ params: { id: string } }>) => ({
    order: { id: ctx.params.id, status: "active" } as Order,
  }),
);

class OrdersController {
  constructor(private orders: OrderService) {}

  cancel = route({
    method: "POST",
    path: "/orders/:id/cancel",
    hooks: { beforeHandle: [withOrder] },
    handler: (ctx) => this.orders.cancel(ctx.order),
  });

  get = route({
    method: "GET",
    path: "/orders/:id",
    handler: (ctx) => {
      const order = this.orders.find(ctx.params.id);

      if (!order) {
        throw new HttpError(404, { code: "order_not_found" });
      }

      return order;
    },
  });
}

describe("calling handlers directly", () => {
  const controller = new OrdersController(new OrderService());

  test("runs the handler with a hand-built context", () => {
    const order: Order = { id: "1", status: "active" };

    const result = controller.cancel.handler(
      testCtx({ params: { id: "1" }, order }),
    );

    expect(result).toEqual({ id: "1", status: "cancelled" });
  });

  test("surfaces handler errors as thrown values", () => {
    expect(() =>
      controller.get.handler(testCtx({ params: { id: "404" } })),
    ).toThrow(HttpError);
  });

  test("a stub server reports its own misuse", () => {
    const ctx = testCtx({ params: {} });

    expect(() => ctx.server.port).toThrow("serve the app");
  });

  test("dependencies are injected by the constructor, with no container", () => {
    const service = new OrderService();
    const isolated = new OrdersController(service);

    isolated.cancel.handler(
      testCtx({ params: { id: "1" }, order: { id: "1", status: "active" } }),
    );

    expect(service.find("1")?.status).toBe("cancelled");
  });
});
