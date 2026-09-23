/**
 * Integration tests: lifecycle hooks through a live server.
 *
 * Response-slot behavior (single start per hook, decoration of every
 * outcome, non-blocking observers, a failing error mapper, recovery when
 * the error path itself throws), thenable results, `onError` scope
 * precedence and the hook context contract.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { HttpError } from "./error.ts";
import { group } from "./group.ts";
import { hook, stack } from "./hook.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

const IdParams: StandardSchemaV1<unknown, { id: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const raw = (value as { id?: unknown }).id;
      const id = Number(raw);

      return Number.isInteger(id)
        ? { value: { id } }
        : { issues: [{ message: "id must be an integer", path: ["id"] }] };
    },
  },
};

const auth = hook.beforeParse((ctx) => {
  if (ctx.req.headers.get("authorization") !== "token") {
    throw new HttpError(401);
  }

  return { user: { id: "u1" } };
});

describe("response-slot hooks on paths where extensions never ran", () => {
  const audited: (string | undefined)[] = [];

  const audit = hook.afterResponse(
    (ctx: Requires<{ res: Response; user?: { id: string } }>) => {
      audited.push(ctx.user?.id);
    },
  );

  class AuditedController {
    get = route({
      method: "GET",
      path: "/audited",
      hooks: { beforeParse: [auth], afterResponse: [audit] },
      handler: (ctx) => ({ by: ctx.user.id }),
    });
  }

  const auditedRequest = serve(createApp({ routes: new AuditedController() }));

  test("the observer records the authenticated request", async () => {
    audited.length = 0;

    const res = await auditedRequest("/audited", {
      headers: { authorization: "token" },
    });

    expect(res.status).toBe(200);
    expect(audited).toEqual(["u1"]);
  });

  test("the observer survives the rejected request it exists to record", async () => {
    audited.length = 0;

    const res = await auditedRequest("/audited");

    expect(res.status).toBe(401);
    expect(audited).toEqual([undefined]);
  });
});

describe("afterResponse is non-blocking", () => {
  let finished = false;

  const slowObserver = hook.afterResponse(async () => {
    await Bun.sleep(60);

    finished = true;
  });

  class SlowController {
    plain = route({
      method: "GET",
      path: "/plain",
      handler: () => ({ ok: true }),
    });

    logged = route({
      method: "GET",
      path: "/logged",
      hooks: { afterResponse: [slowObserver] },
      handler: () => ({ ok: true }),
    });
  }

  const slowRequest = serve(createApp({ routes: new SlowController() }));

  test("an async observer does not delay the response", async () => {
    finished = false;

    const started = performance.now();

    await slowRequest("/logged");

    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(40);
    expect(finished).toBe(false);

    await Bun.sleep(80);

    expect(finished).toBe(true);
  });

  test("a synchronous observer still completes before the response", async () => {
    const seen: number[] = [];

    const syncObserver = hook.afterResponse((ctx) => {
      seen.push(ctx.res.status);
    });

    class SyncController {
      get = route({
        method: "GET",
        path: "/sync",
        hooks: { afterResponse: [syncObserver] },
        handler: () => ({ ok: true }),
      });
    }

    const syncRequest = serve(createApp({ routes: new SyncController() }));

    await syncRequest("/sync");

    expect(seen).toEqual([200]);
  });
});

describe("beforeResponse coverage", () => {
  const tag = hook.beforeResponse((ctx) => {
    const res = new Response(ctx.res.body, ctx.res);

    res.headers.set("x-request-id", "req-1");

    return res;
  });

  const gate = hook.beforeParse((ctx) =>
    ctx.req.headers.get("x-gate") === "closed"
      ? Response.json({ gated: true }, { status: 429 })
      : undefined,
  );

  class TaggedController {
    ok = route({
      method: "GET",
      path: "/ok",
      hooks: { beforeResponse: [tag], beforeParse: [gate] },
      handler: () => ({ ok: true }),
    });

    fails = route({
      method: "GET",
      path: "/fails",
      hooks: { beforeResponse: [tag] },
      handler: () => {
        throw new HttpError(418, { code: "teapot" });
      },
    });
  }

  const taggedRequest = serve(createApp({ routes: new TaggedController() }));

  test("decorates a successful response", async () => {
    const res = await taggedRequest("/ok");

    expect(res.headers.get("x-request-id")).toBe("req-1");
  });

  test("decorates a short-circuited response", async () => {
    const res = await taggedRequest("/ok", { headers: { "x-gate": "closed" } });

    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("req-1");
  });

  test("decorates an error response", async () => {
    const res = await taggedRequest("/fails");

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ code: "teapot" });
    expect(res.headers.get("x-request-id")).toBe("req-1");
  });
});

describe("beforeResponse runs at most once per hook", () => {
  const calls: string[] = [];

  const first = hook.beforeResponse(() => {
    calls.push("first");
  });

  const failing = hook.beforeResponse(() => {
    calls.push("failing");

    throw new HttpError(503, { code: "late_failure" });
  });

  const third = hook.beforeResponse((ctx) => {
    calls.push(`third:${ctx.res.status}`);
  });

  const counting = hook.beforeResponse((ctx) => {
    calls.push(`count:${ctx.res.status}`);
  });

  class OnceController {
    late = route({
      method: "GET",
      path: "/late",
      hooks: { beforeResponse: [first, failing, third] },
      handler: () => ({ ok: true }),
    });

    throwing = route({
      method: "GET",
      path: "/throwing",
      hooks: { beforeResponse: [counting] },
      handler: () => {
        throw new HttpError(400, { code: "bad" });
      },
    });
  }

  const onceRequest = serve(createApp({ routes: new OnceController() }));

  test("a throwing hook is not retried and earlier hooks are not replayed", async () => {
    calls.length = 0;

    const res = await onceRequest("/late");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "late_failure" });
    expect(calls).toEqual(["first", "failing", "third:503"]);
  });

  test("an audit hook sees a handler error exactly once", async () => {
    calls.length = 0;

    const res = await onceRequest("/throwing");

    expect(res.status).toBe(400);
    expect(calls).toEqual(["count:400"]);
  });
});

describe("a failure on the error path", () => {
  const errors = captureErrors();
  const calls: string[] = [];
  const seen: string[] = [];

  const tag = hook.beforeParse((ctx) => {
    ctx.out.headers.set("x-request-id", "req-2");
  });

  const record = hook.onError((ctx) => {
    seen.push(
      ctx.error instanceof HttpError
        ? `HTTP ${ctx.error.status}`
        : (ctx.error as Error).constructor.name,
    );
  });

  const b1 = hook.beforeResponse((ctx) => {
    calls.push(`b1:${ctx.res.status}`);
  });

  const b2 = hook.beforeResponse(() => {
    calls.push("b2");

    throw new HttpError(503, { code: "late_failure" });
  });

  const b3 = hook.beforeResponse((ctx) => {
    calls.push(`b3:${ctx.res.status}`);
  });

  const failEarly = hook.beforeResponse((ctx) => {
    calls.push(`fail:${ctx.res.status}`);

    throw new HttpError(501, { code: "first" });
  });

  const failLate = hook.beforeResponse((ctx) => {
    calls.push(`fail:${ctx.res.status}`);

    throw new HttpError(502, { code: "second" });
  });

  class RecoveryController {
    late = route({
      method: "GET",
      path: "/late-over-error",
      hooks: {
        beforeParse: [tag],
        beforeResponse: [b1, b2, b3],
        onError: [record],
      },
      handler: () => {
        throw new HttpError(418, { code: "teapot" });
      },
    });

    circular = route({
      method: "GET",
      path: "/unmappable",
      hooks: {
        beforeParse: [tag],
        beforeResponse: [b1],
        onError: [record],
      },
      handler: () => {
        const body: Record<string, unknown> = {};

        body.self = body;

        throw new HttpError(400, body);
      },
    });

    allFailing = route({
      method: "GET",
      path: "/all-failing",
      hooks: { beforeResponse: [failEarly, failLate], onError: [record] },
      handler: () => ({ ok: true }),
    });
  }

  const recoveryRequest = serve(
    createApp({ routes: new RecoveryController() }),
  );

  test("a hook throwing over an error response keeps the chain going", async () => {
    calls.length = 0;
    seen.length = 0;

    const res = await recoveryRequest("/late-over-error");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "late_failure" });
    expect(calls).toEqual(["b1:418", "b2", "b3:503"]);
    expect(seen).toEqual(["HTTP 418", "HTTP 503"]);
  });

  test("a hook throwing over an error response still gets ctx.out headers", async () => {
    calls.length = 0;
    seen.length = 0;

    const res = await recoveryRequest("/late-over-error");

    expect(res.headers.get("x-request-id")).toBe("req-2");
  });

  test("a failure of the error path is logged, not swallowed", async () => {
    calls.length = 0;
    seen.length = 0;

    await recoveryRequest("/late-over-error");

    expect(errors.lines.join("\n")).toContain("[tetsu] Error response failed:");
  });

  test("an unmappable error reaches onError and the response chain", async () => {
    calls.length = 0;
    seen.length = 0;

    const res = await recoveryRequest("/unmappable");

    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe("req-2");
    expect(calls).toEqual(["b1:500"]);
    expect(seen).toEqual(["HTTP 400", "TypeError"]);
  });

  test("recovery terminates when every response hook throws", async () => {
    calls.length = 0;
    seen.length = 0;

    const res = await recoveryRequest("/all-failing");

    expect(res.status).toBe(502);
    expect(calls).toEqual(["fail:200", "fail:501"]);
    expect(seen).toEqual(["HTTP 501", "HTTP 502"]);
  });
});

describe("failing error mapper", () => {
  captureErrors();

  test("a non-serializable error body still yields 500 and runs afterResponse", async () => {
    const observed: number[] = [];

    const trace = hook.afterResponse((ctx) => {
      observed.push(ctx.res.status);
    });

    class CircularController {
      boom = route({
        method: "GET",
        path: "/circular",
        hooks: { afterResponse: [trace] },
        handler: () => {
          const body: Record<string, unknown> = {};

          body.self = body;

          throw new HttpError(400, body);
        },
      });
    }

    const res = await serve(createApp({ routes: new CircularController() }))(
      "/circular",
    );

    expect(res.status).toBe(500);
    expect(observed).toEqual([500]);
  });
});

describe("thenable results", () => {
  const lazy = <T>(value: T) => ({
    // biome-ignore lint/suspicious/noThenProperty: a non-Promise thenable is exactly what these tests exercise
    then: (resolve: (v: T) => unknown) => resolve(value),
  });

  test("a handler returning a lazy thenable is awaited", async () => {
    class LazyController {
      get = route({
        method: "GET",
        path: "/lazy",
        handler: () => lazy({ id: "from-thenable" }),
      });
    }

    const res = await serve(createApp({ routes: new LazyController() }))(
      "/lazy",
    );

    expect(await res.json()).toEqual({ id: "from-thenable" });
  });

  test("a hook returning a lazy thenable extends the context", async () => {
    const lazyAuth = hook.beforeParse(() => lazy({ user: { id: "u9" } }));

    class LazyHookController {
      me = route({
        method: "GET",
        path: "/lazy-hook",
        hooks: { beforeParse: [lazyAuth] },
        handler: (ctx) => ctx.user,
      });
    }

    const res = await serve(createApp({ routes: new LazyHookController() }))(
      "/lazy-hook",
    );

    expect(await res.json()).toEqual({ id: "u9" });
  });

  test("a hook returning a lazy thenable Response short-circuits", async () => {
    let handlerRan = false;

    const lazyGate = hook.beforeParse(() =>
      lazy(Response.json({ gated: true }, { status: 429 })),
    );

    class GatedController {
      get = route({
        method: "GET",
        path: "/gated",
        hooks: { beforeParse: [lazyGate] },
        handler: () => {
          handlerRan = true;

          return { fresh: true };
        },
      });
    }

    const res = await serve(createApp({ routes: new GatedController() }))(
      "/gated",
    );

    expect(res.status).toBe(429);
    expect(handlerRan).toBe(false);
  });

  test("a schema validating through a lazy thenable is not skipped", async () => {
    const LazySchema: StandardSchemaV1<unknown, { id: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          lazy(
            Number.isInteger(Number((value as { id?: unknown }).id))
              ? { value: { id: Number((value as { id: unknown }).id) } }
              : {
                  issues: [{ message: "id must be an integer", path: ["id"] }],
                },
          ) as never,
      },
    };

    class LazySchemaController {
      get = route({
        method: "GET",
        path: "/lazy-schema/:id",
        schema: { params: LazySchema },
        handler: (ctx) => ({ id: ctx.params.id }),
      });
    }

    const lazyRequest = serve(
      createApp({ routes: new LazySchemaController() }),
    );

    const rejected = await lazyRequest("/lazy-schema/abc");
    const accepted = await lazyRequest("/lazy-schema/4");

    expect(rejected.status).toBe(422);
    expect(await accepted.json()).toEqual({ id: 4 });
  });
});

describe("onError precedence", () => {
  test("the most specific handler maps the error first", async () => {
    const seen: string[] = [];

    const mapper = (scope: string, status?: number) =>
      hook.onError(() => {
        seen.push(scope);

        return status ? Response.json({ from: scope }, { status }) : undefined;
      });

    class ScopedController {
      boom = route({
        method: "GET",
        path: "/boom",
        hooks: { onError: [mapper("route", 418)] },
        handler: () => {
          throw new Error("x");
        },
      });

      unmapped = route({
        method: "GET",
        path: "/unmapped",
        handler: () => {
          throw new Error("x");
        },
      });
    }

    const scopedAppRequest = serve(
      createApp({
        hooks: { onError: [mapper("app", 500)] },
        routes: group("/zone", {
          hooks: { onError: [mapper("group", 502)] },
          children: [new ScopedController()],
        }),
      }),
    );

    const routeWins = await scopedAppRequest("/zone/boom");

    expect(routeWins.status).toBe(418);
    expect(await routeWins.json()).toEqual({ from: "route" });
    expect(seen).toEqual(["route"]);

    seen.length = 0;

    const groupWins = await scopedAppRequest("/zone/unmapped");

    expect(groupWins.status).toBe(502);
    expect(seen).toEqual(["group"]);
  });

  test("falls through to broader scopes when a handler declines", async () => {
    const seen: string[] = [];

    const decline = (scope: string) =>
      hook.onError(() => {
        seen.push(scope);

        return undefined;
      });

    class DecliningController {
      boom = route({
        method: "GET",
        path: "/boom",
        hooks: { onError: [decline("route")] },
        handler: () => {
          throw new HttpError(409, { code: "conflict" });
        },
      });
    }

    const decliningAppRequest = serve(
      createApp({
        hooks: { onError: [decline("app")] },
        routes: group("/zone", {
          hooks: { onError: [decline("group")] },
          children: [new DecliningController()],
        }),
      }),
    );

    const res = await decliningAppRequest("/zone/boom");

    expect(seen).toEqual(["route", "group", "app"]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "conflict" });
  });
});

describe("hooks context contract", () => {
  test("beforeHandle sees validated params and extensions", async () => {
    const seen: unknown[] = [];

    const spy = hook.beforeHandle(
      (ctx: Requires<{ params: { id: number } }>) => {
        seen.push(ctx.params.id);
      },
    );

    class SpyController {
      probe = route({
        method: "GET",
        path: "/spy/:id",
        schema: { params: IdParams },
        hooks: { beforeHandle: [spy] },
        handler: (ctx) => ({ id: ctx.params.id }),
      });
    }

    const spyAppRequest = serve(createApp({ routes: new SpyController() }));

    await spyAppRequest("/spy/9");

    expect(seen).toEqual([9]);
  });
});

describe("stack() through a served app", () => {
  const withTenant = hook.beforeParse(
    (ctx: Requires<{ user: { id: string } }>) => ({
      tenant: `${ctx.user.id}-acme`,
    }),
  );

  const secured = stack(auth, withTenant);

  class StackedController {
    me = route({
      method: "GET",
      path: "/stacked",
      hooks: { beforeParse: secured },
      handler: (ctx) => ({ by: ctx.user.id, tenant: ctx.tenant }),
    });
  }

  const stackedRequest = serve(createApp({ routes: new StackedController() }));

  test("a reusable stack applies in order with typed extensions", async () => {
    const res = await stackedRequest("/stacked", {
      headers: { authorization: "token" },
    });

    expect(await res.json()).toEqual({ by: "u1", tenant: "u1-acme" });
  });

  test("the stack's guard still rejects on its own", async () => {
    const res = await stackedRequest("/stacked");

    expect(res.status).toBe(401);
  });
});

describe("hooks given as a list of sets", () => {
  const order: string[] = [];

  /** Shaped the way a hook package returns its hooks: a tuple per slot. */
  function recorder(name: string) {
    return {
      beforeParse: [
        hook.beforeParse(() => {
          order.push(`${name}:parse`);
        }),
      ],
      beforeResponse: [
        hook.beforeResponse(() => {
          order.push(`${name}:response`);
        }),
      ],
      onError: [
        hook.onError(() => {
          order.push(`${name}:error`);
        }),
      ],
    } as const;
  }

  class Probe {
    ok = route({
      method: "GET",
      path: "/ok",
      handler: () => {
        order.push("handler");

        return { ok: true };
      },
    });

    fail = route({
      method: "GET",
      path: "/fail",
      handler: () => {
        throw new HttpError(409);
      },
    });
  }

  const request = serve(
    createApp({
      hooks: [recorder("a"), recorder("b")],
      routes: group("/g", {
        hooks: [
          recorder("c"),
          {
            beforeParse: [
              hook.beforeParse(() => {
                order.push("d:parse");
              }),
            ],
          },
        ],
        children: [new Probe()],
      }),
    }),
  );

  test("every slot of every set runs, in the order the list gives", async () => {
    order.length = 0;

    const res = await request("/g/ok");

    expect(res.status).toBe(200);
    expect(order).toEqual([
      "a:parse",
      "b:parse",
      "c:parse",
      "d:parse",
      "handler",
      "a:response",
      "b:response",
      "c:response",
    ]);
  });

  test("onError keeps innermost-first across levels and list order within one", async () => {
    order.length = 0;

    const res = await request("/g/fail");

    expect(res.status).toBe(409);
    expect(order).toEqual([
      "a:parse",
      "b:parse",
      "c:parse",
      "d:parse",
      "c:error",
      "a:error",
      "b:error",
      "a:response",
      "b:response",
      "c:response",
    ]);
  });
});
