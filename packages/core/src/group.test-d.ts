/**
 * Type-level tests for topology groups.
 *
 * @module
 */

import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { group } from "./group.ts";
import { hook, stack } from "./hook.ts";
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

const zoneStack = stack(metrics, guard);

group("/stacked", { hooks: { beforeParse: zoneStack }, children: [] });

createApp({ routes: [], hooks: { beforeParse: zoneStack } });

/** Shaped the way a hook package returns its hooks: a tuple per slot. */
const packaged = {
  beforeParse: [metrics],
  afterResponse: [accessLog],
} as const;

group("/listed", {
  hooks: [packaged, { beforeParse: [guard] }],
  children: [],
});

createApp({ routes: [], hooks: [packaged, { beforeParse: zoneStack }] });

group("/listed-wrong-slot", {
  hooks: [
    packaged,
    {
      // @ts-expect-error each set in the list is checked like a lone one
      beforeParse: [accessLog],
    },
  ],
  children: [],
});

createApp({
  routes: [],
  hooks: [
    {
      // @ts-expect-error a set in the list cannot require what a group lacks
      beforeParse: [needsUser],
    },
    packaged,
  ],
});

group("/listed-bare", {
  hooks: [
    {
      // @ts-expect-error a bare function is not a hook, in a list as alone
      beforeParse: [() => undefined],
    },
  ],
  children: [],
});

group("/listed-widened", {
  hooks: [
    {
      // @ts-expect-error a widened array has no element types left to check
      beforeParse: sharedGuards,
    },
  ],
  children: [],
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

/** What a hook package such as `requestId()` returns. */
const requestIdPackage = { beforeParse: [stamp] } as const;

createApp({
  routes: [],
  hooks: [requestIdPackage, { beforeParse: [needsRequestId] }],
});

group("/scoped", {
  hooks: [requestIdPackage, { beforeParse: [needsRequestId] }],
  children: [],
});

createApp({ routes: [], hooks: { beforeParse: [stamp, needsRequestId] } });

group("/scoped-set", {
  hooks: { beforeParse: [stamp, needsRequestId] },
  children: [],
});

createApp({
  routes: [],
  hooks: [{ beforeHandle: [handleNeedsRequestId] }, requestIdPackage],
});

createApp({
  routes: [],
  hooks: [
    { beforeValidation: [traces] },
    { beforeValidation: [validationNeedsTrace] },
  ],
});

createApp({
  routes: [],
  hooks: [requestIdPackage, { afterResponse: [observesRequestId] }],
});

createApp({
  routes: [],
  hooks: [
    {
      // @ts-expect-error a hook cannot rely on a set that runs after it
      beforeParse: [needsRequestId],
    },
    requestIdPackage,
  ],
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
  hooks: [
    {
      // @ts-expect-error nor on a later set's hook in its own slot
      beforeValidation: [validationNeedsTrace],
    },
    { beforeValidation: [traces] },
  ],
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
  hooks: [
    requestIdPackage,
    {
      // @ts-expect-error after the response, an earlier hook may never have run
      afterResponse: [observesRequestIdSurely],
    },
  ],
});

createApp({
  routes: [],
  hooks: [
    { beforeParse: [normalizesQuery] },
    {
      // @ts-expect-error a part a route's schema owns is not promised past validation
      beforeHandle: [needsQuery],
    },
  ],
});

group("/outer", {
  hooks: requestIdPackage,
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
