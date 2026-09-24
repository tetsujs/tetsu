/**
 * Two ways to test a controller.
 *
 * A handler is a function of its context, so a unit test builds one with
 * `testCtx()` and calls it — no server, no HTTP. What only a request
 * exercises — validation, status codes, the error envelope — goes through
 * `serve()`, which starts the application on a free port and stops it
 * when the tests around it are done.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, HttpError } from "@tetsujs/core";
import { serve, testCtx } from "@tetsujs/core/testing";
import {
  MemoryTodoStore,
  type Todo,
  type TodoStore,
  todosController,
} from "./todos.ts";

describe("a handler, called directly", () => {
  const stored: Todo = { id: 7, title: "write tests", done: false };

  const store: TodoStore = {
    find: (id) => (id === stored.id ? stored : undefined),
    add: () => stored,
  };

  const routes = todosController({ store });

  test("returns what the store holds", () => {
    expect(routes.get.handler(testCtx({ params: { id: 7 } }))).toEqual(stored);
  });

  test("throws a 404 for what it does not", () => {
    expect(() => routes.get.handler(testCtx({ params: { id: 8 } }))).toThrow(
      HttpError,
    );
  });
});

describe("the application, over HTTP", () => {
  const request = serve(
    createApp({ routes: todosController({ store: new MemoryTodoStore() }) }),
  );

  test("creates, then finds", async () => {
    const created = await request("/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ship it" }),
    });

    expect(created.status).toBe(201);

    const { id } = (await created.json()) as Todo;

    expect(await (await request(`/todos/${id}`)).json()).toMatchObject({
      title: "ship it",
    });
  });

  test("refuses an invalid body with 422", async () => {
    const res = await request("/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });

    expect(res.status).toBe(422);
  });
});
