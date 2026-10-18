/**
 * The TanStack Query options against a live application and a real query
 * client: the keys they make and match, what a query and a mutation
 * resolve or fail with, pages, and the signal that aborts a call.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { hashKey, MutationObserver, QueryClient } from "@tanstack/query-core";
import { createApp, httpError, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { AnyHeaders, Fetch } from "./index.ts";
import { ClientError, createClient } from "./index.ts";
import { queryUtils } from "./tanstack.ts";

interface User {
  id: number;
  name: string;
}

interface Api {
  readonly "GET /users/:id": {
    readonly request: {
      readonly params: { id: number };
      readonly headers?: AnyHeaders;
    };
    readonly responses: {
      readonly 200: User;
      readonly 404: { status: 404; error: "USER_NOT_FOUND"; message: string };
    };
  };
  readonly "GET /users": {
    readonly request: {
      readonly query?: { page?: number; role?: string };
      readonly headers?: AnyHeaders;
    };
    readonly responses: {
      readonly 200: { items: User[]; next: number | null };
    };
  };
  readonly "POST /users": {
    readonly request: {
      readonly body: { name: string };
      readonly headers?: AnyHeaders;
    };
    readonly responses: {
      readonly 201: User;
      readonly 409: { status: 409; error: "NAME_TAKEN"; message: string };
    };
  };
  readonly "DELETE /users/:id": {
    readonly request: {
      readonly params: { id: number };
      readonly headers?: AnyHeaders;
    };
    readonly responses: { readonly 204: undefined };
  };
}

class UsersController {
  one = route({
    method: "GET",
    path: "/users/:id",
    handler: (ctx) => {
      if (ctx.params.id === "0") {
        throw httpError(404, "USER_NOT_FOUND", "No such user");
      }

      return { id: Number(ctx.params.id), name: `user ${ctx.params.id}` };
    },
  });

  list = route({
    method: "GET",
    path: "/users",
    handler: (ctx) => {
      const page = Number(new URL(ctx.req.url).searchParams.get("page"));

      return {
        items: [{ id: page, name: `user ${page}` }],
        next: page < 3 ? page + 1 : null,
      };
    },
  });

  create = route({
    method: "POST",
    path: "/users",
    bodyType: "json",
    handler: (ctx) => {
      const { name } = ctx.body as { name: string };

      if (name === "taken") {
        throw httpError(409, "NAME_TAKEN", "The name is taken");
      }

      ctx.out.status = 201;

      return { id: 7, name };
    },
  });

  remove = route({
    method: "DELETE",
    path: "/users/:id",
    handler: (ctx) => {
      ctx.out.status = 204;
    },
  });
}

const request = serve(createApp({ routes: new UsersController() }));

const q = queryUtils(createClient<Api>({ baseUrl: request.url }));

describe("keys", () => {
  test("a query's key is the method, the path and the input but its init", () => {
    const controller = new AbortController();
    const options = q.get("/users/:id").queryOptions({
      params: { id: 1 },
      headers: { "x-trace": "a" },
      init: { signal: controller.signal, credentials: "include" },
    });

    expect([...options.queryKey]).toEqual([
      "GET",
      "/users/:id",
      { params: { id: 1 }, headers: { "x-trace": "a" } },
    ]);
  });

  test("a query without input has an empty one", () => {
    expect([...q.get("/users").queryOptions().queryKey]).toEqual([
      "GET",
      "/users",
      {},
    ]);
  });

  test("key() is the method and the path, or with the input it is given", () => {
    expect(q.get("/users/:id").key()).toEqual(["GET", "/users/:id"]);
    expect(q.get("/users/:id").key({ params: { id: 1 } })).toEqual([
      "GET",
      "/users/:id",
      { params: { id: 1 } },
    ]);
  });

  test("the order of the input's fields does not change the hash", () => {
    const one = q.get("/users").queryOptions({ query: { page: 1, role: "a" } });
    const other = q
      .get("/users")
      .queryOptions({ query: { role: "a", page: 1 } });

    expect(hashKey(one.queryKey)).toBe(hashKey(other.queryKey));
  });

  test("an infinite query's key holds its first page's input, kept apart from a query's", () => {
    const pages = q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 2,
      getNextPageParam: (last) => last.next,
    });

    expect([...pages.queryKey]).toEqual([
      "GET",
      "/users",
      { query: { page: 2 } },
      { infinite: true },
    ]);
    expect(hashKey(pages.queryKey)).not.toBe(
      hashKey(q.get("/users").queryOptions({ query: { page: 2 } }).queryKey),
    );
  });

  test("key() matches every query of the route, and its input narrows it", async () => {
    const client = new QueryClient();

    await client.query(q.get("/users/:id").queryOptions({ params: { id: 1 } }));
    await client.query(q.get("/users/:id").queryOptions({ params: { id: 2 } }));
    await client.query(q.get("/users").queryOptions());
    await client.infiniteQuery(
      q.get("/users").infiniteOptions({
        input: (page) => ({ query: { page } }),
        initialPageParam: 1,
        getNextPageParam: (last) => last.next,
      }),
    );

    const matched = (queryKey: readonly unknown[]) =>
      client
        .getQueryCache()
        .findAll({ queryKey })
        .map((query) => query.queryKey);

    expect(matched(q.get("/users/:id").key())).toHaveLength(2);
    expect(matched(q.get("/users/:id").key({ params: { id: 2 } }))).toEqual([
      ["GET", "/users/:id", { params: { id: 2 } }],
    ]);
    expect(matched(q.get("/users").key())).toHaveLength(2);
    expect(matched(q.post("/users").key())).toEqual([]);
  });

  test("key() leaves out what is undefined, as the hash of a query does", async () => {
    const client = new QueryClient();

    await client.query(
      q.get("/users").queryOptions({ query: { page: 1, role: undefined } }),
    );

    const matched = (queryKey: readonly unknown[]) =>
      client.getQueryCache().findAll({ queryKey });

    expect(q.get("/users").key({ query: { role: undefined } })).toStrictEqual([
      "GET",
      "/users",
      { query: {} },
    ]);
    expect(
      matched(q.get("/users").key({ query: { role: undefined } })),
    ).toHaveLength(1);
    expect(matched(q.get("/users").key({ query: undefined }))).toHaveLength(1);
    expect(matched(q.get("/users").key({ query: { page: 1 } }))).toHaveLength(
      1,
    );
  });
});

describe("queries", () => {
  test("resolve with the body of a success", async () => {
    const client = new QueryClient();
    const options = q.get("/users/:id").queryOptions({ params: { id: 1 } });

    const user = await client.query(options);

    expect(user).toEqual({ id: 1, name: "user 1" });

    const cached = client.getQueryData(options.queryKey);

    expect(cached).toEqual({
      id: 1,
      name: "user 1",
    });
  });

  test("fail with a ClientError that carries the status and the body", async () => {
    const client = new QueryClient();
    const failed = client
      .fetchQuery({
        ...q.get("/users/:id").queryOptions({ params: { id: 0 } }),
        retry: false,
      })
      .catch((error: unknown) => error);

    const error = await failed;

    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      status: 404,
      body: { status: 404, error: "USER_NOT_FOUND" },
    });
  });

  test("resolve with null for a success without a body", async () => {
    const client = new QueryClient();
    const options = q.delete("/users/:id").queryOptions({ params: { id: 1 } });

    expect(await client.query(options)).toBeNull();
    expect(client.getQueryState(options.queryKey)?.status).toBe("success");
  });

  test("page by the param each page is fetched with", async () => {
    const client = new QueryClient();
    const options = q.get("/users").infiniteOptions({
      input: (page) => ({ query: { page } }),
      initialPageParam: 1,
      getNextPageParam: (last) => last.next,
    });

    const data = await client.infiniteQuery({ ...options, pages: 3 });

    expect(data.pageParams).toEqual([1, 2, 3]);
    expect(data.pages.map((page) => page.items[0]?.id)).toEqual([1, 2, 3]);
  });

  test("abort the call when the query is cancelled", async () => {
    const signals: AbortSignal[] = [];
    const hold: Fetch = (_url, init) => {
      if (init.signal) {
        signals.push(init.signal);
      }

      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    };

    const held = queryUtils(createClient<Api>({ fetch: hold }));
    const client = new QueryClient();
    const options = held.get("/users/:id").queryOptions({ params: { id: 1 } });
    const pending = client.query(options).catch(() => undefined);

    await Bun.sleep(0);
    await client.cancelQueries({ queryKey: options.queryKey });
    await pending;

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("abort the call by its own signal too", async () => {
    const signals: AbortSignal[] = [];
    const hold: Fetch = (_url, init) => {
      if (init.signal) {
        signals.push(init.signal);
      }

      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    };

    const own = new AbortController();
    const held = queryUtils(createClient<Api>({ fetch: hold }));
    const client = new QueryClient();
    const pending = client
      .fetchQuery({
        ...held.get("/users/:id").queryOptions({
          params: { id: 1 },
          init: { signal: own.signal },
        }),
        retry: false,
      })
      .catch((error: unknown) => error);

    await Bun.sleep(0);
    own.abort();
    await pending;

    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("mutations", () => {
  test("send their variables and resolve with the body", async () => {
    const client = new QueryClient();
    const observer = new MutationObserver(
      client,
      q.post("/users").mutationOptions(),
    );

    expect(await observer.mutate({ body: { name: "ann" } })).toEqual({
      id: 7,
      name: "ann",
    });
    expect(q.post("/users").mutationOptions().mutationKey).toEqual([
      "POST",
      "/users",
    ]);
  });

  test("fail with a ClientError", async () => {
    const client = new QueryClient();
    const observer = new MutationObserver(
      client,
      q.post("/users").mutationOptions(),
    );

    const error = await observer
      .mutate({ body: { name: "taken" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      status: 409,
      body: { error: "NAME_TAKEN" },
    });
  });

  test("resolve with undefined for a success without a body", async () => {
    const client = new QueryClient();
    const observer = new MutationObserver(
      client,
      q.delete("/users/:id").mutationOptions(),
    );

    expect(await observer.mutate({ params: { id: 1 } })).toBeUndefined();
  });
});

test("nothing of TanStack Query is imported at run time", async () => {
  const source = await Bun.file(
    new URL("./tanstack.ts", import.meta.url),
  ).text();
  const imports = source.match(/^import [^;]+;/gm) ?? [];

  expect(imports.filter((line) => line.includes("@tanstack"))).toEqual(
    imports.filter(
      (line) => line.includes("@tanstack") && line.startsWith("import type"),
    ),
  );
});
