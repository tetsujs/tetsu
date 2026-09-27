/**
 * The error path answers without waiting when nothing along it waits.
 *
 * The success path was made synchronous until its first promise because
 * `async` frames with nothing to await were most of the overhead over raw
 * Bun. Every failure — a `404`, a `405`, a refusal, a thrown `HttpError` —
 * takes the error path, and it used to be four such frames. Bun is handed
 * what the pipeline returns, so whether a failure was answered in the same
 * tick shows as a `Response` rather than a promise of one.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

const server = {} as Server<unknown>;

const request = (method: string, path: string) =>
  Object.assign(new Request(`http://localhost${path}`, { method }), {
    params: {},
  });

const routes = {
  gone: route({
    method: "GET",
    path: "/gone",
    handler: () => {
      throw new HttpError(410);
    },
  }),
};

describe("a failure nothing waits on", () => {
  const app = createApp({ routes });
  const gone = app.routes["/gone"];

  test("a thrown HttpError is answered in the same tick", () => {
    const res = gone?.(request("GET", "/gone") as never, server);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(410);
  });

  test("so is a 405", () => {
    const res = gone?.(request("DELETE", "/gone") as never, server);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(405);
  });

  test("so is one an onError hook answers synchronously", () => {
    const mapped = createApp({
      hooks: {
        onError: [hook.onError(() => new Response("mapped", { status: 418 }))],
      },
      routes,
    });

    const res = mapped.routes["/gone"]?.(
      request("GET", "/gone") as never,
      server,
    );

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(418);
  });
});

describe("a protocol failure the application's onError sees", () => {
  test("is answered in the same tick when the hook answers so", () => {
    const passing = createApp({
      hooks: { onError: [hook.onError(() => undefined)] },
      routes,
    });

    const res = passing.routes["/gone"]?.(
      request("DELETE", "/gone") as never,
      server,
    );

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(405);
    expect((res as Response).headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("a failure something waits on", () => {
  test("an asynchronous onError hook is waited for", async () => {
    const waiting = createApp({
      hooks: {
        onError: [
          hook.onError(async () => new Response("later", { status: 418 })),
        ],
      },
      routes,
    });

    const res = waiting.routes["/gone"]?.(
      request("GET", "/gone") as never,
      server,
    );

    expect(res).toBeInstanceOf(Promise);
    expect((await res)?.status).toBe(418);
  });

  test("so is an asynchronous beforeResponse hook on the way out", async () => {
    const waiting = createApp({
      hooks: { beforeResponse: [hook.beforeResponse(async () => undefined)] },
      routes,
    });

    const res = waiting.routes["/gone"]?.(
      request("GET", "/gone") as never,
      server,
    );

    expect((await res)?.status).toBe(410);
  });
});
