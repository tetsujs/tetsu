/**
 * Bring your own validator: one body, four libraries.
 *
 * The framework talks to validators only through Standard Schema, so any
 * library that implements it plugs into `schema` the same way, and
 * `ctx.body` is typed from it. For the OpenAPI document a schema must also
 * emit JSON Schema: Zod and ArkType do it themselves, Valibot through
 * `toStandardJsonSchema`, TypeBox through `tb()`.
 *
 * What each costs — per request, to declare, and in memory — is measured
 * in `bench/` (`bun run --cwd bench validators`): TypeBox's compiled check
 * is the fastest on a valid body, Valibot the lightest to load.
 *
 * ```sh
 * bun examples/validators.ts
 * for lib in zod arktype valibot typebox; do
 *   curl -X POST localhost:3000/$lib -H 'content-type: application/json' \
 *     -d '{"name":"pen","qty":3}'; echo
 * done
 * curl localhost:3000/openapi.json       # all four bodies described
 * ```
 *
 * @module
 */

import { controller, createApp, route } from "@tetsujs/core";
import { docs } from "@tetsujs/openapi";
import { Type, tb } from "@tetsujs/typebox";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";

const WithZod = z.object({ name: z.string().min(1), qty: z.number().int() });

const WithArkType = type({ name: "string > 0", qty: "number.integer" });

const WithValibot = toStandardJsonSchema(
  v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    qty: v.pipe(v.number(), v.integer()),
  }),
);

const WithTypeBox = tb(
  Type.Object({ name: Type.String({ minLength: 1 }), qty: Type.Integer() }),
);

const itemsController = controller("Items", () => ({
  zod: route({
    method: "POST",
    path: "/zod",
    schema: { body: WithZod },
    handler: (ctx) => ctx.body,
  }),

  arktype: route({
    method: "POST",
    path: "/arktype",
    schema: { body: WithArkType },
    handler: (ctx) => ctx.body,
  }),

  valibot: route({
    method: "POST",
    path: "/valibot",
    schema: { body: WithValibot },
    handler: (ctx) => ctx.body,
  }),

  typebox: route({
    method: "POST",
    path: "/typebox",
    schema: { body: WithTypeBox },
    handler: (ctx) => ctx.body,
  }),
}));

export default createApp({
  routes: [
    itemsController(),
    docs({ info: { title: "Validators", version: "1.0.0" } }),
  ],
});
