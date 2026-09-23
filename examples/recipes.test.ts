/**
 * Every recipe, served and asked one question — so an example that stops
 * working fails a test instead of a reader.
 *
 * `shutdown.ts` is not here: it serves itself and takes over the process's
 * signals, which is its point and no test's business.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { serve } from "@tetsujs/core/testing";
import cookies from "./cookies.ts";
import groups from "./groups.ts";
import hello from "./hello.ts";
import hooks from "./hooks.ts";
import openapi from "./openapi.ts";
import responses from "./responses.ts";
import streaming from "./streaming.ts";
import todos from "./todos.ts";
import uploads from "./uploads.ts";
import validation from "./validation.ts";
import validators from "./validators.ts";
import websocket from "./websocket.ts";

const json = (body: unknown, init: RequestInit = {}): RequestInit => ({
  method: "POST",
  ...init,
  headers: { "content-type": "application/json", ...init.headers },
  body: JSON.stringify(body),
});

const quiet = spyOn(console, "log");

beforeAll(() => quiet.mockImplementation(() => undefined));

afterAll(() => quiet.mockRestore());

describe("recipes", () => {
  test("hello", async () => {
    const res = await serve(hello)("/hello/ada");

    expect(await res.json()).toEqual({ hello: "ada" });
  });

  test("validation", async () => {
    const request = serve(validation);

    expect((await request("/items/x")).status).toBe(422);
    expect(
      (await request("/items", json({ name: "pen", qty: 3 }))).status,
    ).toBe(201);
  });

  test("responses", async () => {
    const request = serve(responses);

    expect(await (await request("/users/1")).json()).toEqual({
      id: 1,
      name: "Ada",
    });
    expect((await request("/users/1", { method: "DELETE" })).status).toBe(204);
  });

  test("hooks", async () => {
    const request = serve(hooks);
    const ada = { headers: { authorization: "Bearer ada" } };

    expect((await request("/orders/1")).status).toBe(401);
    expect((await request("/orders/2", ada)).status).toBe(404);
    expect(
      (await request("/orders/1/cancel", { method: "POST", ...ada })).status,
    ).toBe(200);
    expect(
      (await request("/orders/1/cancel", { method: "POST", ...ada })).status,
    ).toBe(409);
  });

  test("groups", async () => {
    const request = serve(groups);

    expect(
      (await request("/api/status")).headers.get("x-request-id"),
    ).toBeTruthy();
    expect((await request("/api/admin/stats")).status).toBe(403);
  });

  test("cookies", async () => {
    const request = serve(cookies);
    const login = await request("/login", json({ name: "ada" }));
    const session = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    expect(
      await (await request("/me", { headers: { cookie: session } })).json(),
    ).toEqual({ name: "ada" });
    expect(
      (await request("/me", { headers: { cookie: "session=ada.forged" } }))
        .status,
    ).toBe(422);
  });

  test("uploads", async () => {
    const form = new FormData();

    form.set("title", "logo");
    form.set(
      "image",
      new File([new Uint8Array(8)], "logo.png", { type: "image/png" }),
    );

    const res = await serve(uploads)("/images", { method: "POST", body: form });

    expect(await res.json()).toMatchObject({ name: "logo.png", bytes: 8 });
  });

  test("websocket", async () => {
    const request = serve(websocket);

    expect((await request("/chat/general")).status).toBe(401);
  });

  test("streaming", async () => {
    const res = await serve(streaming)("/export.csv");

    expect((await res.text()).split("\n")[0]).toBe("id,total");
  });

  test("openapi", async () => {
    const res = await serve(openapi)("/openapi.json");
    const document = (await res.json()) as { paths: Record<string, unknown> };

    expect(Object.keys(document.paths)).toContain("/api/books/{id}");
  });

  test("validators", async () => {
    const request = serve(validators);

    const document = (await (await request("/openapi.json")).json()) as {
      paths: Record<
        string,
        {
          post?: {
            requestBody?: { content: Record<string, { schema?: unknown }> };
          };
        }
      >;
    };

    for (const library of ["zod", "arktype", "valibot", "typebox"]) {
      const res = await request(`/${library}`, json({ name: "pen", qty: 3 }));

      expect(await res.json()).toEqual({ name: "pen", qty: 3 });
      expect(
        document.paths[`/${library}`]?.post?.requestBody?.content[
          "application/json"
        ]?.schema,
      ).toMatchObject({ properties: { name: {}, qty: {} } });
    }
  });

  test("todos", async () => {
    expect((await serve(todos)("/todos", json({ title: "x" }))).status).toBe(
      201,
    );
  });
});
