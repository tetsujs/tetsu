/**
 * Type-level tests for what an application remembers about its routes.
 *
 * The map is what a generated client reads, so what matters is that a
 * plain `createApp({ routes: … })` — no `as const`, written the way an
 * application is actually written — carries the method, the full path with
 * every group prefix joined, and the schemas.
 *
 * @module
 */

import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { AppRoutes } from "./app.ts";
import { createApp } from "./app.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import { ws } from "./ws.ts";

const User = mockSchema<{ id: number; name: string }>();
const CreateUser = mockSchema<{ name: string }>();
const Page = mockSchema<{ page: number }>();

const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));

class UsersController {
  list = route({
    method: "GET",
    path: "/users",
    schema: { query: Page, response: User },
    handler: () => [] as never,
  });

  create = route({
    method: "POST",
    path: "/users",
    schema: { body: CreateUser, response: User },
    hooks: { beforeParse: [auth] },
    handler: () => ({}) as never,
  });

  notARoute = "a field that is not a route";
}

class HealthController {
  live = route({ method: "GET", path: "/live", handler: () => ({ ok: true }) });

  feed = ws({ path: "/feed", message: () => undefined });
}

const app = createApp({
  routes: [
    group("/api", {
      children: [group("/v1", { children: [new UsersController()] })],
    }),
    new HealthController(),
  ],
});

type Routes = AppRoutes<typeof app>;

export type applicationRouteCases = [
  Expect<
    Equal<
      keyof Routes,
      "GET /api/v1/users" | "POST /api/v1/users" | "GET /live"
    >
  >,
  Expect<Equal<Routes["GET /api/v1/users"]["method"], "GET">>,
  Expect<Equal<Routes["POST /api/v1/users"]["path"], "/api/v1/users">>,
  Expect<
    Equal<Routes["POST /api/v1/users"]["schema"]["body"], typeof CreateUser>
  >,
  Expect<Equal<Routes["GET /api/v1/users"]["schema"]["query"], typeof Page>>,
];

/**
 * A socket endpoint is not callable like a route, so it is absent from the
 * map — and its absence is what a client should see.
 */
export type socketAbsenceCases = [
  Expect<Equal<Extract<keyof Routes, `${string}/feed`>, never>>,
];

/** An application declared without groups keeps its paths as written. */
const flat = createApp({ routes: new HealthController() });

export type flatCases = [
  Expect<Equal<keyof AppRoutes<typeof flat>, "GET /live">>,
];

/** A single controller, not wrapped in an array, walks the same way. */
const single = createApp({
  routes: group("/api", { children: [new UsersController()] }),
});

export type singleCases = [
  Expect<
    Equal<keyof AppRoutes<typeof single>, "GET /api/users" | "POST /api/users">
  >,
];
