/**
 * The client against a live application: what it puts on the wire, read
 * back by the routes as the core reads it, and what it makes of each kind
 * of response.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, httpError, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { FetchInit } from "./index.ts";
import { ClientError, createClient, unwrap } from "./index.ts";

/** Takes whatever comes, so a route sees the query as the core parsed it. */
const anything: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as Record<string, unknown> }),
  },
};

/**
 * What the echo route answers. Its routes declare no response, so the
 * client knows their bodies as `unknown`; the tests say what they read.
 */
interface Echo {
  readonly name: string;
  readonly path: string;
  readonly query: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const until = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

class WireController {
  echo = route({
    method: "GET",
    path: "/echo/:name",
    schema: { query: anything },
    handler: (ctx) => ({
      name: ctx.params.name,
      path: new URL(ctx.req.url).pathname,
      query: ctx.query,
      headers: Object.fromEntries(ctx.req.headers),
    }),
  });

  pair = route({
    method: "GET",
    path: "/pairs/:left/:right-side",
    handler: (ctx) => ctx.params,
  });

  files = route({
    method: "GET",
    path: "/files/*",
    handler: (ctx) => ({ path: new URL(ctx.req.url).pathname }),
  });

  json = route({
    method: "POST",
    path: "/json",
    bodyType: "json",
    handler: (ctx) => ({
      body: ctx.body,
      type: ctx.req.headers.get("content-type"),
    }),
  });

  replace = route({
    method: "PUT",
    path: "/json",
    bodyType: "json",
    handler: (ctx) => ({ method: "PUT", body: ctx.body }),
  });

  amend = route({
    method: "PATCH",
    path: "/json",
    bodyType: "json",
    handler: (ctx) => ({ method: "PATCH", body: ctx.body }),
  });

  form = route({
    method: "POST",
    path: "/form",
    bodyType: "form",
    handler: async (ctx) => {
      const avatar = ctx.body.avatar;

      return {
        title: ctx.body.title,
        tag: ctx.body.tag,
        at: ctx.body.at,
        keys: Object.keys(ctx.body),
        avatar:
          avatar instanceof File
            ? { name: avatar.name, content: await avatar.text() }
            : null,
      };
    },
  });

  text = route({
    method: "POST",
    path: "/text",
    bodyType: "text",
    handler: (ctx) => ({ upper: ctx.body.toUpperCase() }),
  });

  stream = route({
    method: "POST",
    path: "/stream",
    bodyType: "stream",
    handler: async (ctx) => {
      let seen = 0;

      for await (const chunk of ctx.body) {
        seen += chunk.byteLength;
      }

      return { seen };
    },
  });

  remove = route({
    method: "DELETE",
    path: "/things/:id",
    schema: { response: { 204: null } },
    handler: () => undefined,
  });

  missing = route({
    method: "GET",
    path: "/missing",
    handler: () => {
      throw httpError(404, "THING_NOT_FOUND", "No such thing");
    },
  });

  plain = route({
    method: "GET",
    path: "/plain",
    handler: () =>
      new Response("hello", { headers: { "content-type": "text/plain" } }),
  });

  problem = route({
    method: "GET",
    path: "/problem",
    handler: () =>
      new Response(JSON.stringify({ title: "Gone" }), {
        status: 410,
        headers: { "content-type": "application/problem+json; charset=utf-8" },
      }),
  });

  emptyJson = route({
    method: "GET",
    path: "/empty-json",
    handler: () =>
      new Response(null, {
        status: 204,
        headers: { "content-type": "application/json" },
      }),
  });

  broken = route({
    method: "GET",
    path: "/broken",
    handler: () =>
      new Response("{not json", {
        headers: { "content-type": "application/json" },
      }),
  });

  slow = route({
    method: "GET",
    path: "/slow",
    handler: async (ctx) => {
      await until(ctx.req.signal);

      return { late: true };
    },
  });

  session = route({
    method: "POST",
    path: "/session",
    handler: (ctx) => {
      ctx.out.cookies.set("session", "s1");

      return { signedIn: true };
    },
  });

  me = route({
    method: "GET",
    path: "/me",
    handler: (ctx) => ({ session: ctx.req.cookies?.get("session") }),
  });
}

const request = serve(createApp({ routes: new WireController() }));

const api = createClient({ baseUrl: request.url });

describe("the address", () => {
  test("a parameter is one segment: a slash, a percent sign and Unicode come back as sent", async () => {
    for (const name of ["a/b", "50%", "ф x", "?#&"]) {
      const data = unwrap(
        await api.get("/echo/:name", { params: { name } }),
      ) as Echo;

      expect(data.name).toBe(name);
    }
  });

  test("a parameter's name runs to the next slash, as the core reads it", async () => {
    const res = unwrap(
      await api.get("/pairs/:left/:right-side", {
        params: { left: 1, "right-side": "r" },
      }),
    );

    expect(res).toEqual({ left: "1", "right-side": "r" });
  });

  test("an array repeats the key, which the core reads back as the array", async () => {
    const res = unwrap(
      await api.get("/echo/:name", {
        params: { name: "q" },
        query: { tag: ["a", "b"], one: "x", none: undefined, n: 7 },
      }),
    ) as Echo;

    expect(res.query).toEqual({ tag: ["a", "b"], one: "x", n: "7" });
  });

  test("a date travels as its ISO string, in the path, the query and a header", async () => {
    const at = new Date("2026-10-16T12:00:00.000Z");

    const res = unwrap(
      await api.get("/echo/:name", {
        params: { name: at },
        query: { at },
        headers: { "x-at": at },
      }),
    ) as Echo;

    expect(res.name).toBe(at.toISOString());
    expect(res.query).toEqual({ at: at.toISOString() });
    expect(res.headers["x-at"]).toBe(at.toISOString());
  });

  test("a parameter without a value throws before anything is sent", async () => {
    await expect(api.get("/echo/:name")).rejects.toThrow(
      'No value for the parameter "name" of /echo/:name',
    );
  });

  test("a value that would move the request to another path throws before anything is sent", async () => {
    for (const id of ["", ".", ".."]) {
      await expect(
        api.delete("/things/:id", { params: { id } }),
      ).rejects.toThrow(`"${id}" cannot be the parameter "id" of /things/:id`);
    }
  });

  test("a path that would move the request to another host throws before anything is sent", async () => {
    const sent: string[] = [];
    const relative = createClient({
      fetch: async (url) => {
        sent.push(url);

        return new Response(null, { status: 204 });
      },
    });

    for (const path of [
      "//evil.example/x",
      "/\\evil.example/x",
      "@evil.example/x",
      "evil",
    ]) {
      await expect(relative.get(path as `/${string}`)).rejects.toThrow(
        `${path} is not a path: it does not start with a single "/", and the request could go to another host`,
      );
      expect(() => relative.url(path as `/${string}`)).toThrow("is not a path");
    }

    expect(sent).toEqual([]);
  });

  test("the wildcard takes a path: each segment encoded, the slashes kept", async () => {
    const data = unwrap(
      await api.get("/files/*", { params: { "*": "docs/a b/50%.txt" } }),
    ) as Echo;

    expect(data.path).toBe("/files/docs/a%20b/50%25.txt");
  });

  test("a wildcard segment that would climb out of the route throws", async () => {
    for (const rest of ["../secret", "a/./b", "a/.."]) {
      await expect(
        api.get("/files/*", { params: { "*": rest } }),
      ).rejects.toThrow("cannot be the parameter");
    }

    await expect(api.get("/files/*")).rejects.toThrow(
      'No value for the parameter "*" of /files/*',
    );
  });

  test("url() is the address a call would request", () => {
    const local = createClient({ baseUrl: "https://api.example.com/v1/" });

    expect(
      local.url("/echo/:name", {
        params: { name: "a b" },
        query: { tag: ["x", "y"] },
      }),
    ).toBe("https://api.example.com/v1/echo/a%20b?tag=x&tag=y");
    expect(local.url("/plain")).toBe("https://api.example.com/v1/plain");
    expect(
      createClient({ baseUrl: "https://api.example.com/v1//" }).url("/plain"),
    ).toBe("https://api.example.com/v1/plain");
  });
});

describe("headers", () => {
  test("the client's headers go with every request, and a call's own win", async () => {
    let token = "t1";

    const signed = createClient({
      baseUrl: request.url,
      headers: async () => ({
        authorization: `Bearer ${token}`,
        "x-shared": "client",
      }),
    });

    const first = unwrap(
      await signed.get("/echo/:name", {
        params: { name: "h" },
        headers: { "x-shared": "call", "x-skip": undefined },
      }),
    ) as Echo;

    token = "t2";

    const second = unwrap(
      await signed.get("/echo/:name", { params: { name: "h" } }),
    ) as Echo;

    expect(first.headers.authorization).toBe("Bearer t1");
    expect(first.headers["x-shared"]).toBe("call");
    expect(first.headers).not.toHaveProperty("x-skip");
    expect(second.headers.authorization).toBe("Bearer t2");
  });

  test("the client's content-type does not override the type a body carries", async () => {
    const seen: (string | undefined)[] = [];

    const typed = createClient({
      headers: { "content-type": "application/json" },
      fetch: async (_, init) => {
        seen.push(init.headers["content-type"]);

        return new Response(null, { status: 204 });
      },
    });

    await typed.post("/form", { form: { title: "Hello" } });
    await typed.post("/form", { body: new FormData() });
    await typed.post("/form", { body: new URLSearchParams({ a: "1" }) });
    await typed.post("/stream", {
      body: new Blob(["x"], { type: "image/png" }),
    });
    await typed.post("/stream", { body: new Blob(["x"]) });
    await typed.post("/text", { body: "words" });

    expect(seen).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "application/json",
      "application/json",
    ]);
  });

  test("a form goes as a form even when the client sends JSON by default", async () => {
    const typed = createClient({
      baseUrl: request.url,
      headers: { "content-type": "application/json" },
    });

    const data = unwrap(
      await typed.post("/form", { form: { title: "Hello" } }),
    );

    expect(data).toMatchObject({ title: "Hello" });
  });

  test("a call's content-type wins over the one the body sets", async () => {
    const res = unwrap(
      await api.post("/text", {
        body: "plain words",
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(res).toEqual({ upper: "PLAIN WORDS" });
  });
});

describe("the body", () => {
  test("a value is sent as JSON", async () => {
    const res = unwrap(
      await api.post("/json", { body: { name: "Ada", tags: [1, 2] } }),
    );

    expect(res).toEqual({
      body: { name: "Ada", tags: [1, 2] },
      type: "application/json",
    });
  });

  test("put and patch send their own method", async () => {
    const put = unwrap(await api.put("/json", { body: { n: 1 } }));
    const patch = unwrap(await api.patch("/json", { body: { n: 2 } }));

    expect(put).toEqual({ method: "PUT", body: { n: 1 } });
    expect(patch).toEqual({ method: "PATCH", body: { n: 2 } });
  });

  test("form is sent as form data: files as files, the rest as text, arrays repeated", async () => {
    const at = new Date("2026-10-16T12:00:00.000Z");

    const res = unwrap(
      await api.post("/form", {
        form: {
          title: "Hello",
          tag: ["a", "b"],
          at,
          skipped: undefined,
          avatar: new File(["png!"], "me.png", { type: "image/png" }),
        },
      }),
    );

    expect(res).toEqual({
      title: "Hello",
      tag: ["a", "b"],
      at: at.toISOString(),
      keys: ["title", "tag", "at", "avatar"],
      avatar: { name: "me.png", content: "png!" },
    });
  });

  test("a string is sent as it is", async () => {
    const res = unwrap(await api.post("/text", { body: "shout" }));

    expect(res).toEqual({ upper: "SHOUT" });
  });

  test("a stream is sent as it is", async () => {
    const chunks = ["one ", "two ", "three"];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();

        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
    });

    const res = unwrap(await api.post("/stream", { body }));

    expect(res).toEqual({ seen: 13 });
  });
});

describe("a stream body outside Bun", () => {
  test("goes with duplex: half, which fetch in Node and browsers requires", async () => {
    const seen: FetchInit[] = [];

    const spied = createClient({
      fetch: async (_, init) => {
        seen.push(init);

        return new Response(null, { status: 204 });
      },
    });

    await spied.post("/stream", { body: new ReadableStream() });
    await spied.post("/json", { body: { a: 1 } });

    expect(seen.map((init) => (init as { duplex?: string }).duplex)).toEqual([
      "half",
      undefined,
    ]);
  });
});

describe("the response", () => {
  test("204 is a success without data", async () => {
    const res = await api.delete("/things/:id", { params: { id: 1 } });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(res.ok && res.data).toBeUndefined();
  });

  test("an error status is a result, its JSON body the error", async () => {
    const res = await api.get("/missing");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.ok ? undefined : res.error).toEqual({
      status: 404,
      message: "No such thing",
      error: "THING_NOT_FOUND",
    });
  });

  test("a +json type is read as JSON", async () => {
    const res = await api.get("/problem");

    expect(res.status).toBe(410);
    expect(res.ok ? undefined : res.error).toEqual({ title: "Gone" });
  });

  test("a body that is not JSON is left on the response, unread", async () => {
    const res = await api.get("/plain");

    expect(res.ok && res.data).toBeUndefined();
    expect(await res.response.text()).toBe("hello");
  });

  test("an empty body is no data, whatever its type says", async () => {
    const res = await api.get("/empty-json");

    expect(res.status).toBe(204);
    expect(res.ok && res.data).toBeUndefined();
  });

  test("a JSON body that does not parse throws", async () => {
    await expect(api.get("/broken")).rejects.toThrow(SyntaxError);
  });

  test("a network failure throws", async () => {
    const away = createClient({ baseUrl: "http://127.0.0.1:1" });

    await expect(away.get("/plain")).rejects.toThrow();
  });

  test("an aborted signal aborts the request", async () => {
    const controller = new AbortController();
    const pending = api.get("/slow", { init: { signal: controller.signal } });

    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("unwrap", () => {
  test("a success gives its data", async () => {
    expect(unwrap(await api.post("/json", { body: 1 }))).toEqual({
      body: 1,
      type: "application/json",
    });
  });

  test("a failure throws a ClientError carrying the status, the body and the response", async () => {
    const res = await api.get("/missing");

    let thrown: unknown;

    try {
      unwrap(res);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClientError);
    expect(thrown).toMatchObject({
      name: "ClientError",
      message: "The server answered 404",
      status: 404,
      body: { error: "THING_NOT_FOUND" },
      response: res.response,
    });
  });
});

describe("a fetch of its own", () => {
  test("receives the address and the request, headers as a record", async () => {
    const seen: [string, FetchInit][] = [];

    const spied = createClient({
      baseUrl: "https://api.example.com",
      headers: { "x-shared": "1" },
      fetch: async (url, init) => {
        seen.push([url, init]);

        return Response.json({ ok: true });
      },
    });

    await spied.post("/json", {
      body: { a: 1 },
      init: { credentials: "include" },
    });

    expect(seen).toEqual([
      [
        "https://api.example.com/json",
        {
          credentials: "include",
          method: "POST",
          headers: { "content-type": "application/json", "x-shared": "1" },
          body: '{"a":1}',
        },
      ],
    ]);
  });

  test("the core's test client fits, and keeps its cookies across calls", async () => {
    const session = createClient({ fetch: request.client() });

    await session.post("/session");

    const res = unwrap(await session.get("/me"));

    expect(res).toEqual({ session: "s1" });
  });
});

describe("the client's init", () => {
  test("goes with every request, under a call's own", async () => {
    const seen: FetchInit[] = [];

    const spied = createClient({
      init: { credentials: "include", cache: "no-store" },
      fetch: async (_, init) => {
        seen.push(init);

        return Response.json({ ok: true });
      },
    });

    await spied.get("/plain");
    await spied.get("/plain", { init: { cache: "reload" } });

    expect(seen).toEqual([
      { credentials: "include", cache: "no-store", method: "GET", headers: {} },
      { credentials: "include", cache: "reload", method: "GET", headers: {} },
    ]);
  });

  test("does not override what the runtime sets", async () => {
    const seen: FetchInit[] = [];

    const spied = createClient({
      init: {
        method: "PUT",
        headers: { "x-init": "1" },
        body: "no",
      } as RequestInit,
      fetch: async (_, init) => {
        seen.push(init);

        return Response.json({ ok: true });
      },
    });

    await spied.post("/json", { body: { a: 1 } });

    expect(seen).toEqual([
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      },
    ]);
  });

  test("its signal aborts a call that has a signal of its own", async () => {
    const controller = new AbortController();

    const aborting = createClient({
      baseUrl: request.url,
      init: { signal: controller.signal },
    });

    const pending = aborting.get("/slow", {
      init: { signal: new AbortController().signal },
    });

    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a call's signal still aborts it", async () => {
    const controller = new AbortController();

    const aborting = createClient({
      baseUrl: request.url,
      init: { signal: new AbortController().signal },
    });

    const pending = aborting.get("/slow", {
      init: { signal: controller.signal },
    });

    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
