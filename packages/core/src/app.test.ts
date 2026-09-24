/**
 * Integration tests: the core request flow through a live server.
 *
 * Requests go over a real socket because Bun's native router — the only
 * router the framework has — is unreachable in process. That makes these
 * tests exercise exactly the path a deployed application takes.
 *
 * One shared application covers the happy path, validation and parsing,
 * hook basics, error mapping, protocol behavior (404/405/HEAD/OPTIONS) and
 * serving via `Bun.serve({ ...app })`. Focused suites live in the sibling
 * `app-*.test.ts` files.
 *
 * @module
 */

import { describe, expect, spyOn, test } from "bun:test";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
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

const CreateItem: StandardSchemaV1<unknown, { qty: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const qty = (value as { qty?: unknown } | null)?.qty;

      return typeof qty === "number"
        ? { value: { qty } }
        : { issues: [{ message: "qty must be a number", path: ["qty"] }] };
    },
  },
};

const TagsQuery: StandardSchemaV1<unknown, { tag: string[] }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const tag = (value as { tag?: unknown }).tag;

      if (typeof tag === "string") {
        return { value: { tag: [tag] } };
      }

      if (Array.isArray(tag)) {
        return { value: { tag: tag as string[] } };
      }

      return { issues: [{ message: "tag is required", path: ["tag"] }] };
    },
  },
};

const auth = hook.beforeParse((ctx) => {
  if (ctx.req.headers.get("authorization") !== "token") {
    throw new HttpError(401);
  }

  return { user: { id: "u1" } };
});

const seenByAfterResponse: number[] = [];

const recordStatus = hook.afterResponse((ctx) => {
  seenByAfterResponse.push(ctx.res.status);
});

class ItemsController {
  get = route({
    method: "GET",
    path: "/items/:id",
    schema: { params: IdParams },
    handler: (ctx) => ({ id: ctx.params.id }),
  });

  create = route({
    method: "POST",
    path: "/items",
    schema: { body: CreateItem },
    hooks: { beforeParse: [auth] },
    handler: (ctx) => ({ qty: ctx.body.qty, by: ctx.user.id }),
  });

  echo = route({
    method: "POST",
    path: "/echo",
    handler: (ctx) => ({ bodyWasParsed: ctx.req.bodyUsed }),
  });

  created = route({
    method: "POST",
    path: "/created",
    handler: (ctx) => {
      ctx.out.status = 201;

      return { ok: true };
    },
  });

  raw = route({
    method: "GET",
    path: "/raw",
    handler: () => new Response("plain text", { status: 200 }),
  });

  empty = route({
    method: "DELETE",
    path: "/items/:id",
    handler: () => undefined,
  });

  search = route({
    method: "GET",
    path: "/search",
    schema: { query: TagsQuery },
    handler: (ctx) => ({ tags: ctx.query.tag }),
  });
}

const cached = hook.beforeParse(
  () => new Response("from cache", { status: 200 }),
);

let shortCircuitedHandlerRan = false;

class CacheController {
  cachedRoute = route({
    method: "GET",
    path: "/cached",
    hooks: { beforeParse: [cached], afterResponse: [recordStatus] },
    handler: () => {
      shortCircuitedHandlerRan = true;

      return { fresh: true };
    },
  });
}

const boom = new Error("secret internals");

class FailingController {
  teapot = route({
    method: "GET",
    path: "/teapot",
    hooks: {
      onError: [
        hook.onError((ctx) =>
          ctx.error instanceof RangeError
            ? Response.json({ error: "teapot" }, { status: 418 })
            : undefined,
        ),
      ],
    },
    handler: () => {
      throw new RangeError("kettle overflow");
    },
  });

  crash = route({
    method: "GET",
    path: "/crash",
    hooks: { afterResponse: [recordStatus] },
    handler: () => {
      throw boom;
    },
  });
}

class AdminController {
  stats = route({
    method: "GET",
    path: "/stats",
    handler: () => ({ users: 1 }),
  });
}

const app = createApp({
  routes: [
    new ItemsController(),
    new CacheController(),
    new FailingController(),
    group("/admin", {
      hooks: {
        beforeParse: [
          hook.beforeParse((ctx) => {
            if (ctx.req.headers.get("x-role") !== "admin") {
              throw new HttpError(403);
            }
          }),
        ],
      },
      children: [new AdminController()],
    }),
  ],
});

const request = serve(app);

const get = (path: string, init?: RequestInit) => request(path, init);

const post = (path: string, body: string, headers?: Record<string, string>) =>
  request(path, { method: "POST", body, headers });

describe("happy path", () => {
  test("serves JSON with schema-coerced params", async () => {
    const res = await get("/items/5");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 5 });
  });

  test("passes a raw Response through untouched", async () => {
    const res = await get("/raw");

    expect(await res.text()).toBe("plain text");
  });

  test("applies ctx.out.status to the serialized result", async () => {
    const res = await post("/created", "");

    expect(res.status).toBe(201);
  });

  test("turns an undefined handler result into 204", async () => {
    const res = await get("/items/5", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("materializes repeated query keys as arrays", async () => {
    const res = await get("/search?tag=a&tag=b");

    expect(await res.json()).toEqual({ tags: ["a", "b"] });
  });
});

describe("validation and parsing", () => {
  test("rejects invalid params with 422 and part-prefixed issues", async () => {
    const res = await get("/items/abc");

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      status: 422,
      message: "Validation failed",
      error: "VALIDATION_FAILED",
      issues: [{ message: "id must be an integer", path: ["params", "id"] }],
    });
  });

  test("the 422 envelope carries nothing but the failure and issues", async () => {
    const res = await get("/items/abc");

    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).toSorted()).toEqual([
      "error",
      "issues",
      "message",
      "status",
    ]);
  });

  test("validates the body after auth passes", async () => {
    const res = await post("/items", JSON.stringify({ qty: "many" }), {
      authorization: "token",
    });

    expect(res.status).toBe(422);
  });

  test("accepts a valid body and hands the coerced value to the handler", async () => {
    const res = await post("/items", JSON.stringify({ qty: 3 }), {
      authorization: "token",
    });

    expect(await res.json()).toEqual({ qty: 3, by: "u1" });
  });

  test("answers 400 for malformed JSON", async () => {
    const res = await post("/items", "{not json", { authorization: "token" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 400,
      message: "Body is not valid JSON",
      error: "MALFORMED_JSON",
    });
  });

  test("401 from beforeParse precedes 422 from validation", async () => {
    const res = await post("/items", JSON.stringify({ qty: "many" }));

    expect(res.status).toBe(401);
  });

  test("never reads the body without a body schema", async () => {
    const res = await post("/echo", JSON.stringify({ some: "payload" }));

    expect(await res.json()).toEqual({ bodyWasParsed: false });
  });
});

describe("hooks", () => {
  test("a Response from beforeParse short-circuits the handler", async () => {
    const res = await get("/cached");

    expect(await res.text()).toBe("from cache");
    expect(shortCircuitedHandlerRan).toBe(false);
  });

  test("group guards protect the whole zone", async () => {
    const denied = await get("/admin/stats");
    const allowed = await get("/admin/stats", {
      headers: { "x-role": "admin" },
    });

    expect(denied.status).toBe(403);
    expect(await allowed.json()).toEqual({ users: 1 });
  });
});

describe("errors", () => {
  const errors = captureErrors();

  test("a route onError hook can map an error", async () => {
    const res = await get("/teapot");

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot" });
  });

  test("unknown errors become an opaque 500", async () => {
    const res = await get("/crash");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
      error: "INTERNAL_SERVER_ERROR",
    });
  });

  test("what the client is spared is logged instead", async () => {
    await get("/crash");

    expect(errors.lines.join("\n")).toContain("[tetsu] Unhandled error:");
    expect(errors.lines.join("\n")).toContain("secret internals");
  });

  test("afterResponse runs for successes and errors alike", async () => {
    seenByAfterResponse.length = 0;

    await get("/cached");
    await get("/crash");

    expect(seenByAfterResponse).toEqual([200, 500]);
  });
});

describe("protocol", () => {
  test("unknown paths get 404", async () => {
    const res = await get("/nope");

    expect(res.status).toBe(404);
  });

  test("known path with a wrong method gets 405 and Allow", async () => {
    const res = await get("/items/5", { method: "PATCH" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("allow")).toContain("HEAD");
  });

  test("HEAD is answered from the GET route with the body stripped", async () => {
    const res = await get("/items/5", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("OPTIONS answers with the path's Allow set", async () => {
    const res = await get("/items/5", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("allow")?.split(", ").toSorted()).toEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
    ]);
  });

  test("registers one native handler per declared path", () => {
    expect(Object.keys(app.routes)).toContain("/items/:id");
    expect(typeof app.routes["/items/:id"]).toBe("function");
  });
});

describe("Bun.serve integration", () => {
  test("the App object is a valid Bun.serve config as-is", async () => {
    const server = Bun.serve({ ...app, port: 0 });

    try {
      const native = await fetch(new URL("/items/5", server.url));
      const fallback = await fetch(new URL("/nope", server.url));
      const head = await fetch(new URL("/items/5", server.url), {
        method: "HEAD",
      });

      expect(await native.json()).toEqual({ id: 5 });
      expect(fallback.status).toBe(404);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("group guards work through the native router", async () => {
    const server = Bun.serve({ ...app, port: 0 });

    try {
      const denied = await fetch(new URL("/admin/stats", server.url));

      expect(denied.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});

describe("diagnostics", () => {
  test("app.entries lists every route with its mounted path", () => {
    const listed = app.entries.map((entry) => `${entry.method} ${entry.path}`);

    expect(listed).toContain("GET /admin/stats");
    expect(
      listed.filter((line) => line.endsWith(" /items/:id")).toSorted(),
    ).toEqual(["DELETE /items/:id", "GET /items/:id"]);
  });

  test("printRoutes prints one line per route", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      app.printRoutes();

      const lines = log.mock.calls.map((call) => String(call[0]));

      expect(lines).toHaveLength(app.entries.length);
      expect(lines.some((line) => line.includes("/admin/stats"))).toBe(true);
      expect(lines.some((line) => line.includes("AdminController"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("a duplicate method+path fails at startup, naming both owners", () => {
    class First {
      r = route({ method: "GET", path: "/dup", handler: () => ({ n: 1 }) });
    }

    class Second {
      r = route({ method: "GET", path: "/dup", handler: () => ({ n: 2 }) });
    }

    expect(() => createApp({ routes: [new First(), new Second()] })).toThrow(
      'Duplicate route: GET /dup is defined by both "First" and "Second"',
    );
  });

  test("a controller without routes warns at startup", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      class Hollow {}

      createApp({ routes: new Hollow() });

      const warned = warn.mock.calls.map((call) => String(call[0]));

      expect(
        warned.some((line) => line.includes('"Hollow" defines no routes')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a hook mounted twice", () => {
  const once = hook.beforeParse(() => undefined);

  class Twice {
    read = route({
      method: "GET",
      path: "/twice",
      hooks: { beforeParse: [once] },
      handler: () => null,
    });
  }

  class Plain {
    read = route({ method: "GET", path: "/read", handler: () => null });
  }

  test("on a group and a route it passes through is refused at startup", () => {
    expect(() =>
      createApp({
        routes: group("/zone", {
          hooks: { beforeParse: [once] },
          children: [new Twice()],
        }),
      }),
    ).toThrow(
      "GET /zone/twice: the same hook is mounted twice in its beforeParse chain",
    );
  });

  test("on the application and a route is refused too", () => {
    expect(() =>
      createApp({ hooks: { beforeParse: [once] }, routes: new Twice() }),
    ).toThrow("GET /twice: the same hook is mounted twice");
  });

  test("twice in one slot of the application is refused with no route at all", () => {
    expect(() =>
      createApp({ hooks: { beforeParse: [once, once] }, routes: [] }),
    ).toThrow(
      "The application: the same hook is mounted twice in its beforeParse chain",
    );
  });

  test("on two groups no route passes through both is fine", () => {
    expect(() =>
      createApp({
        routes: [
          group("/left", {
            hooks: { beforeParse: [once] },
            children: [new Plain()],
          }),
          group("/right", {
            hooks: { beforeParse: [once] },
            children: [new Plain()],
          }),
        ],
      }),
    ).not.toThrow();
  });

  test("two instances of the same kind are two hooks", () => {
    const again = hook.beforeParse(() => undefined);

    class Both {
      read = route({
        method: "GET",
        path: "/both",
        hooks: { beforeParse: [again] },
        handler: () => null,
      });
    }

    expect(() =>
      createApp({ hooks: { beforeParse: [once] }, routes: new Both() }),
    ).not.toThrow();
  });
});

describe("resolved options", () => {
  test("app.options fills every default in", () => {
    expect(app.options).toEqual({
      validationStatus: 422,
      validateResponses: true,
      maxBodySize: 1024 * 1024,
    });
  });

  test("app.options reports what was configured", () => {
    const configured = createApp({
      routes: [],
      validation: { status: 400 },
      validateResponses: false,
      maxBodySize: 2048,
    });

    expect(configured.options).toEqual({
      validationStatus: 400,
      validateResponses: false,
      maxBodySize: 2048,
    });
  });
});

describe("environment independence", () => {
  const envReads = ["Bun.env", "process.env", "import.meta.env", "NODE_ENV"];

  test("no framework code reads the environment", async () => {
    const sources = new Bun.Glob("**/*.ts").scan({
      cwd: new URL(".", import.meta.url).pathname,
    });

    const readers: string[] = [];

    for await (const file of sources) {
      if (file.endsWith(".test.ts") || file.endsWith(".test-d.ts")) {
        continue;
      }

      const source = await Bun.file(
        new URL(file, import.meta.url).pathname,
      ).text();

      const reads = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("*") && !line.startsWith("//"))
        .some((line) => envReads.some((form) => line.includes(form)));

      if (reads) {
        readers.push(file);
      }
    }

    expect(readers).toEqual([]);
  });
});
