/**
 * Type-level tests for `rawBody`: the bytes are in the context only of a
 * route that asked for them.
 *
 * @module
 */

import { testCtx } from "../test-utils/ctx.ts";
import type { AppRoutes } from "./app.ts";
import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

const signed = hook.beforeValidation(
  (ctx: Requires<{ rawBody: Uint8Array }>) => {
    void ctx.rawBody;
  },
);

export const asked = route({
  method: "POST",
  path: "/webhook",
  rawBody: true,
  hooks: { beforeValidation: [signed] },
  handler: (ctx) => {
    const bytes: Uint8Array = ctx.rawBody;

    return { length: bytes.byteLength };
  },
});

export const notAsked = route({
  method: "POST",
  path: "/plain",
  bodyType: "json",
  handler: (ctx) => {
    // @ts-expect-error a route that did not ask has no raw body
    void ctx.rawBody;

    return {};
  },
});

export const hookWithout = route({
  method: "POST",
  path: "/unsigned",
  bodyType: "json",
  // @ts-expect-error the hook needs the raw body, and the route did not ask for it
  hooks: { beforeValidation: [signed] },
  handler: () => ({}),
});

export const withForm = route({
  method: "POST",
  path: "/form",
  rawBody: true,
  // @ts-expect-error a form is parsed natively, and its bytes are not kept
  bodyType: "form",
  handler: () => ({}),
});

export const withStream = route({
  method: "POST",
  path: "/stream",
  rawBody: true,
  // @ts-expect-error a stream is the raw body already
  bodyType: "stream",
  handler: () => ({}),
});

const app = createApp({ routes: { asked } });

export const mapped: "POST /webhook" extends keyof AppRoutes<typeof app>
  ? true
  : false = true;

// A handler that reads the bytes is called in a unit test with the bytes it
// reads, no HTTP involved.
export const unit = asked.handler(
  testCtx({ params: {}, body: {}, rawBody: new TextEncoder().encode("{}") }),
);
