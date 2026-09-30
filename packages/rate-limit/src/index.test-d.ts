/**
 * Type-level tests for what the key of a limit may read.
 *
 * @module
 */

import type { Requires, StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import { rateLimit } from "./index.ts";

const clientIp = hook.beforeParse(() => ({ clientIp: "203.0.113.7" }));

const byClient = rateLimit({
  limit: 5,
  windowMs: 60_000,
  key: (ctx: Requires<{ clientIp: string }>) => ctx.clientIp,
});

const bySession = rateLimit({
  limit: 5,
  windowMs: 60_000,
  key: (ctx) => ctx.req.cookies?.get("session") ?? undefined,
});

const handler = () => ({});

export const onApplication = createApp({
  hooks: { beforeParse: [clientIp, byClient, bySession] },
  routes: { read: route({ method: "GET", path: "/", handler }) },
});

export const onRoute = route({
  method: "GET",
  path: "/one",
  hooks: { beforeParse: [clientIp, byClient] },
  handler,
});

export const beforeItsSource = createApp({
  // @ts-expect-error the key reads clientIp, which no hook before it provides
  hooks: { beforeParse: [byClient, clientIp] },
  routes: { read: route({ method: "GET", path: "/", handler }) },
});

export const withoutItsSource = route({
  method: "GET",
  path: "/two",
  // @ts-expect-error the key reads clientIp, and nothing on the route provides it
  hooks: { beforeParse: [byClient] },
  handler,
});

const perAccount = rateLimit({
  slot: "beforeHandle",
  limit: 5,
  windowMs: 900_000,
  key: (ctx: Requires<{ body: { email: string } }>) => ctx.body.email,
});

const Login: StandardSchemaV1<unknown, { email: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as { email: string } }),
  },
};

export const afterValidation = route({
  method: "POST",
  path: "/login",
  schema: { body: Login },
  hooks: { beforeHandle: [perAccount] },
  handler,
});

export const tooEarly = route({
  method: "POST",
  path: "/early",
  schema: { body: Login },
  // @ts-expect-error a limiter made for beforeHandle does not go into beforeParse
  hooks: { beforeParse: [perAccount] },
  handler,
});

export const withoutTheBody = route({
  method: "POST",
  path: "/no-body",
  // @ts-expect-error the key reads a validated body, and the route has none
  hooks: { beforeHandle: [perAccount] },
  handler,
});

// @ts-expect-error a limit after the handler protects nothing
rateLimit({ slot: "afterResponse", limit: 1, windowMs: 1_000, key: () => "k" });
