/**
 * Elysia 2 (beta), in the configuration a variant names: `default`,
 * `precompile` (every route compiled before listening). Its ahead-of-time
 * compilation is not an option but a build step: the `aot` variant is
 * this file bundled with `elysia/plugin/aot/bun`, which the benchmark
 * builds before it runs.
 *
 * @module
 */

import { Elysia, t } from "elysia";
import { host } from "./host.ts";

const configs = {
  default: {},
  aot: {},
  precompile: { precompile: true },
} as const;

const variant = (Bun.env.BENCH_VARIANT ?? "default") as keyof typeof configs;

/**
 * Exported unlistened: the AOT plugin imports this module at build time and
 * compiles the app it finds, so listening belongs to a direct run only.
 */
export const app = new Elysia(configs[variant])
  .get("/ping", () => ({ pong: true }))
  .group("/users", (zone) =>
    zone
      .derive(() => ({ user: { id: "u1" } }))
      .afterResponse(() => undefined)
      .get("/:id", ({ params, user }) => ({ id: params.id, by: user.id })),
  )
  .post(
    "/items",
    { body: t.Object({ name: t.String(), qty: t.Number() }) },
    ({ body }) => body,
  );

if (import.meta.main) {
  app.listen(0);
  host(app.server?.port ?? 0);
}
