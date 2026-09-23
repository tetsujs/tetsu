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
