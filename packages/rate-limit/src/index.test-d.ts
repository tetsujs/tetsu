/**
 * Type-level tests for what the key of a limit may read.
 *
 * @module
 */

import type { Requires } from "@tetsujs/core";
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
