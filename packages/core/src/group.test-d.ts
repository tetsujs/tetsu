/**
 * Type-level tests for topology groups.
 *
 * @module
 */

import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import type { HooksConfig } from "./stack.ts";

const metrics = hook.beforeParse(() => undefined);

const accessLog = hook.afterResponse(() => undefined);

const guard = hook.beforeParse(() => {
  return undefined;
});

const needsUser = hook.beforeParse(
  (ctx: Requires<{ user: { id: string } }>) => {
    void ctx.user.id;
  },
);

group("/api", {
  hooks: { beforeParse: [metrics, guard], afterResponse: [accessLog] },
  children: [],
});

group("/api", {
  hooks: {
    // @ts-expect-error an afterResponse hook cannot go into the beforeParse slot
    beforeParse: [accessLog],
  },
  children: [],
});

group("/api", {
  children: [group("/admin", { children: [] })],
});

group("/api", {
  hooks: {
    // @ts-expect-error a group cannot satisfy a hook that requires ctx.user
    beforeParse: [needsUser],
  },
  children: [],
});

const needsParamsAndUser = hook.beforeParse(
  (ctx: Requires<{ params: Record<string, string>; user: { id: string } }>) => {
    void ctx.user.id;
  },
);

const needsTenantParam = hook.beforeParse(
  (ctx: Requires<{ params: { tenantId: string } }>) => {
    void ctx.params.tenantId;
  },
);

group("/api", {
  hooks: {
    // @ts-expect-error requiring ctx.user on top of the slot base is still more than a group provides
    beforeParse: [needsParamsAndUser],
  },
  children: [],
});

group("/api", {
  hooks: {
    // @ts-expect-error requiring a narrower params shape than raw strings must be rejected
    beforeParse: [needsTenantParam],
  },
  children: [],
});

group("/api", {
  hooks: {
    // @ts-expect-error one failing hook poisons its tuple even next to a valid one
    beforeParse: [metrics, needsUser],
  },
  children: [],
});

group("/api", {
  hooks: {
    // @ts-expect-error a bare function must be wrapped with a hook.* factory
    beforeParse: [() => undefined],
  },
  children: [],
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error a bare function must be wrapped with a hook.* factory
    afterResponse: [() => undefined],
  },
});

const decorate = hook.beforeResponse((ctx) => {
  void ctx.res.status;
});

const mapError = hook.onError((ctx) => {
  void ctx.error;
});

group("/api", {
  hooks: { beforeResponse: [decorate], onError: [mapError] },
  children: [],
});

createApp({
  routes: [],
  hooks: { beforeParse: [metrics, guard], afterResponse: [accessLog] },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error the application cannot satisfy a hook that requires ctx.user
    beforeParse: [needsUser],
  },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error requiring a narrower params shape than raw strings must be rejected
    beforeParse: [needsTenantParam],
  },
});

// @ts-expect-error a group prefix must start with "/"
group("api", { children: [] });

// @ts-expect-error a bare "/" prefix mounts nothing
group("/", { children: [] });

// @ts-expect-error a group prefix must not end with "/"
group("/api/", { children: [] });

// @ts-expect-error a group prefix cannot declare parameters
group("/tenants/:tenantId", { children: [] });

// @ts-expect-error a group prefix cannot contain a wildcard
group("/api/*", { children: [] });

const sharedGuards = [metrics];

group("/widened", {
  hooks: {
    // @ts-expect-error a widened array has no element types left to check
    beforeParse: sharedGuards,
  },
  children: [],
});

const zoneHooks: HooksConfig = { beforeParse: [metrics] };

// @ts-expect-error a HooksConfig annotation widens every slot to an array
group("/annotated", { hooks: zoneHooks, children: [] });

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error a widened array has no element types left to check
    beforeParse: sharedGuards,
  },
});

// @ts-expect-error a HooksConfig annotation widens every slot to an array
createApp({ routes: [], hooks: zoneHooks });

const zoneTuple = [metrics, guard] as const;

group("/tupled", { hooks: { beforeParse: zoneTuple }, children: [] });

createApp({ routes: [], hooks: { beforeParse: zoneTuple } });

/** Shaped the way a hook package returned its hooks before 0.3.0. */
const packaged = {
  beforeParse: [metrics],
  afterResponse: [accessLog],
} as const;

group("/listed", {
  // @ts-expect-error hooks is an object keyed by slot, not a list of sets
  hooks: [packaged, { beforeParse: [guard] }],
  children: [],
});

createApp({
  routes: [],
  // @ts-expect-error a list is refused on the application too
  hooks: [packaged],
});

createApp({
  routes: [],
  // @ts-expect-error even a list of single hooks
  hooks: [metrics, guard],
});

const stamp = hook.beforeParse(() => ({ requestId: "r" }));

const maybeStamp = hook.beforeParse((ctx) =>
  ctx.req.headers.has("x-trace") ? { requestId: "r" } : undefined,
);

const needsRequestId = hook.beforeParse(
  (ctx: Requires<{ requestId: string }>) => {
    void ctx.requestId;
  },
);

const handleNeedsRequestId = hook.beforeHandle(
  (ctx: Requires<{ requestId: string }>) => {
    void ctx.requestId;
  },
);

const validationNeedsTrace = hook.beforeValidation(
  (ctx: Requires<{ trace: string }>) => {
    void ctx.trace;
  },
);

const traces = hook.beforeValidation(() => ({ trace: "t" }));

const observesRequestId = hook.afterResponse(
  (ctx: Requires<{ res: Response; requestId?: string }>) => {
    void ctx.requestId;
  },
);

const observesRequestIdSurely = hook.afterResponse(
  (ctx: Requires<{ res: Response; requestId: string }>) => {
    void ctx.requestId;
  },
);

const normalizesQuery = hook.beforeParse(() => ({ query: { page: "1" } }));

const needsQuery = hook.beforeHandle(
  (ctx: Requires<{ query: { page: string } }>) => {
    void ctx.query.page;
  },
);

const parseNeedsTrace = hook.beforeParse((ctx: Requires<{ trace: string }>) => {
  void ctx.trace;
});

createApp({ routes: [], hooks: { beforeParse: [stamp, needsRequestId] } });

group("/scoped", {
  hooks: { beforeParse: [stamp, needsRequestId] },
  children: [],
});

createApp({
  routes: [],
  hooks: { beforeHandle: [handleNeedsRequestId], beforeParse: [stamp] },
});

createApp({
  routes: [],
  hooks: { beforeValidation: [traces, validationNeedsTrace] },
});

createApp({
  routes: [],
  hooks: { beforeParse: [stamp], afterResponse: [observesRequestId] },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error a hook cannot rely on the hook after it in its tuple
    beforeParse: [needsRequestId, stamp],
  },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error nor on a later hook of its own slot
    beforeValidation: [validationNeedsTrace, traces],
  },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error nor on a slot that runs after its own, whatever the key order
    beforeParse: [parseNeedsTrace],
    beforeValidation: [traces],
  },
});

createApp({
  routes: [],
  hooks: {
    // @ts-expect-error a hook that may skip contributes a field that may be absent
    beforeParse: [maybeStamp, needsRequestId],
  },
});

createApp({
  routes: [],
  hooks: {
    beforeParse: [stamp],
    // @ts-expect-error after the response, an earlier hook may never have run
    afterResponse: [observesRequestIdSurely],
  },
});

createApp({
  routes: [],
  hooks: {
    beforeParse: [normalizesQuery],
    // @ts-expect-error a part a route's schema owns is not promised past validation
    beforeHandle: [needsQuery],
  },
});

group("/outer", {
  hooks: { beforeParse: [stamp] },
  children: [
    group("/inner", {
      hooks: {
        // @ts-expect-error an enclosing group's hooks are not this group's
        beforeParse: [needsRequestId],
      },
      children: [],
    }),
  ],
});

const indexed: Record<string, (typeof stamp)[]> = { beforeParse: [stamp] };

createApp({
  routes: [],
  // @ts-expect-error an object with an index signature has no slot that could be checked
  hooks: indexed,
});

group("/indexed", {
  // @ts-expect-error nor on a group
  hooks: indexed,
  children: [],
});
