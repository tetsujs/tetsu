/**
 * Elysia 1.4, in the configuration a variant names: `default` (`aot` on,
 * as 1.x ships), `no-aot` (`aot: false`, handlers composed without
 * `new Function`), `precompile` (every route compiled before listening
 * instead of on its first request).
 *
 * @module
 */

import { Elysia, t } from "elysia-v1";
import { host } from "./host.ts";

const configs = {
  default: {},
  "no-aot": { aot: false },
  precompile: { precompile: true },
} as const;

const variant = (Bun.env.BENCH_VARIANT ?? "default") as keyof typeof configs;

const app = new Elysia(configs[variant])
  .get("/ping", () => ({ pong: true }))
  .guard({}, (zone) =>
    zone
      .derive(() => ({ user: { id: "u1" } }))
      .onAfterResponse(() => undefined)
      .get("/users/:id", ({ params, user }) => ({
        id: params.id,
        by: user.id,
      })),
  )
  .post("/items", ({ body }) => body, {
    body: t.Object({ name: t.String(), qty: t.Number() }),
  })
  .listen(0);

host(app.server?.port ?? 0);
