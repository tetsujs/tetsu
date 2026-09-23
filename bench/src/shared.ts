/**
 * The Tetsu application `cost.ts` measures in process.
 *
 * The HTTP comparison between frameworks lives in `http.ts`, with every
 * target a process of its own under `targets/` — importing every
 * framework into one module, as this file once did for it, is what made
 * their memory impossible to tell apart.
 *
 * @module
 */

import { createApp, hook, route, type StandardSchemaV1 } from "@tetsujs/core";
import { Type, tb } from "@tetsujs/typebox";

const QtyBody: StandardSchemaV1<unknown, { qty: number }> = {
  "~standard": {
    version: 1,
    vendor: "bench",
    validate: (value) => {
      const qty = (value as { qty?: unknown } | null)?.qty;

      return typeof qty === "number"
        ? { value: { qty } }
        : { issues: [{ message: "qty must be a number", path: ["qty"] }] };
    },
  },
};

const QtyBodyTb = tb(Type.Object({ qty: Type.Number() }));

const attachUser = hook.beforeParse(() => ({ user: { id: "u1" } }));

const observe = hook.afterResponse(() => undefined);

export const tetsuApp = createApp({
  routes: [
    route({ method: "GET", path: "/ping", handler: () => ({ pong: true }) }),
    route({
      method: "GET",
      path: "/user",
      hooks: { beforeParse: [attachUser], afterResponse: [observe] },
      handler: (ctx) => ctx.user,
    }),
    route({
      method: "POST",
      path: "/items",
      schema: { body: QtyBody },
      handler: (ctx) => ctx.body,
    }),
    route({
      method: "POST",
      path: "/items-tb",
      schema: { body: QtyBodyTb },
      handler: (ctx) => ctx.body,
    }),
  ],
});
