/**
 * Tetsu: three routes of a controller, one of them behind a
 * contributing hook and an observer.
 *
 * The `typebox` variant validates `POST /items` with a DTO from
 * `@tetsujs/typebox`, compiled once at declaration, instead of the
 * hand-written checker the other targets share — loaded only in that
 * variant, so the default's memory is not charged for it.
 *
 * The core is read from its sources through the repository's `paths`, not
 * from the `dist` a user runs. Measured both ways, the difference is
 * within the noise — idle memory 23.4 MB from sources, 25.6 MB from
 * `dist` — and importing `dist` would make type-checking the repository
 * depend on a build.
 *
 * @module
 */

import { createApp, hook, route } from "@tetsujs/core";
import { host } from "./host.ts";
import { ItemSchema } from "./item.ts";

const body =
  Bun.env.BENCH_VARIANT === "typebox" ? await typeboxItem() : ItemSchema;

async function typeboxItem() {
  const { tb } = await import("@tetsujs/typebox");
  const { Type } = await import("typebox");

  return tb(Type.Object({ name: Type.String(), qty: Type.Number() }));
}

const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));

const observe = hook.afterResponse(() => undefined);

const routes = {
  ping: route({
    method: "GET",
    path: "/ping",
    handler: () => ({ pong: true }),
  }),

  user: route({
    method: "GET",
    path: "/users/:id",
    hooks: { beforeParse: [auth], afterResponse: [observe] },
    handler: (ctx) => ({ id: ctx.params.id, by: ctx.user.id }),
  }),

  items: route({
    method: "POST",
    path: "/items",
    schema: { body },
    handler: (ctx) => ctx.body,
  }),
};

const server = Bun.serve({ ...createApp({ routes }), port: 0 });

host(server.port ?? 0);
