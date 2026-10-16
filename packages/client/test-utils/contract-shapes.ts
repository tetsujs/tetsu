/**
 * Applications whose contracts test the printer's edges: brands it strips,
 * an application under another export and name, and types it cannot write.
 * Compiled by the generator, never run.
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { z } from "zod";
import { mockSchema } from "../../core/test-utils/mock-schema.ts";
// @ts-expect-error a module that is not there, for a type that does not resolve
import type { Missing } from "./missing.ts";

const UserId = z.string().brand<"UserId">();

export const branded = createApp({
  routes: [
    route({
      method: "GET",
      path: "/accounts/:id",
      schema: {
        params: z.object({ id: z.coerce.number().brand<"AccountId">() }),
        response: z.object({ id: UserId, owner: UserId.nullable() }),
      },
      handler: () => ({
        id: UserId.parse("u"),
        owner: null,
      }),
    }),
  ],
});

export default createApp({
  routes: [route({ method: "GET", path: "/health", handler: () => "ok" })],
});

export const notAnApp = { routes: [] };

interface Callback {
  onDone: () => void;
}

interface Tagged {
  tag: symbol;
}

interface Rewrite {
  rewriter: HTMLRewriter;
}

interface Unresolved {
  value: Missing;
}

export const unwritable = createApp({
  routes: [
    route({
      method: "POST",
      path: "/callbacks",
      schema: { body: mockSchema<Callback, Callback>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/symbols",
      schema: { body: mockSchema<Tagged, Tagged>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/rewrites",
      schema: { body: mockSchema<Rewrite, Rewrite>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/missing",
      schema: { body: mockSchema<Unresolved, Unresolved>() },
      handler: () => "ok",
    }),
  ],
});
