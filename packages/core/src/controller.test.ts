/**
 * Tests for controllers declared with `controller()`: the name they carry,
 * where it shows, and the names the route table refuses.
 *
 * @module
 */

import { describe, expect, spyOn, test } from "bun:test";
import { testCtx } from "../test-utils/ctx.ts";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { controller } from "./controller.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

class Greeter {
  greet(name: string) {
    return `hello, ${name}`;
  }
}

interface GreetDeps {
  readonly greeter: Greeter;
}

const greetController = controller("Greet", ({ greeter }: GreetDeps) => {
  const named = hook.beforeParse(() => ({ who: "ada" }));

  return {
    hello: route({
      method: "GET",
      path: "/hello",
      hooks: { beforeParse: [named] },
      handler: (ctx) => ({ text: greeter.greet(ctx.who), route: ctx.route }),
    }),
  };
});

describe("a named controller", () => {
  const request = serve(
    createApp({ routes: greetController({ greeter: new Greeter() }) }),
  );

  test("builds its routes from the dependencies it is given", async () => {
    const res = await request("/hello");

    expect(await res.json()).toMatchObject({ text: "hello, ada" });
  });

  test("its name is what a request sees as ctx.route.controller", async () => {
    const res = await request("/hello");

    expect(await res.json()).toMatchObject({
      route: { controller: "Greet", name: "hello" },
    });
  });

  test("is an ordinary object of routes, its name out of every listing", () => {
    const built = greetController({ greeter: new Greeter() });

    expect(Object.keys(built)).toEqual(["hello"]);
  });

  test("a handler is unit-tested without a server", () => {
    const built = greetController({ greeter: new Greeter() });

    expect(
      built.hello.handler(testCtx({ params: {}, who: "bob" })),
    ).toMatchObject({
      text: "hello, bob",
    });
  });

  test("printRoutes names it", () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });

    try {
      createApp({
        routes: greetController({ greeter: new Greeter() }),
      }).printRoutes();
    } finally {
      log.mockRestore();
    }

    expect(lines).toEqual(["GET    /hello  → Greet"]);
  });

  test("a controller with no dependencies takes none", async () => {
    const health = controller("Health", () => ({
      live: route({ method: "GET", path: "/live", handler: () => ({ ok: 1 }) }),
    }));

    const res = await serve(createApp({ routes: health() }))("/live");

    expect(await res.json()).toEqual({ ok: 1 });
  });
});

describe("a name", () => {
  test("is required where the controller is declared", () => {
    expect(() => controller("", () => ({}))).toThrow(
      "A controller needs a name",
    );
    expect(() => controller("  ", () => ({}))).toThrow(
      "A controller needs a name",
    );
  });

  test("shared by two controllers of one application is refused at startup", () => {
    const first = controller("Users", () => ({
      list: route({ method: "GET", path: "/a", handler: () => [] }),
    }));
    const second = controller("Users", () => ({
      list: route({ method: "GET", path: "/b", handler: () => [] }),
    }));

    expect(() => createApp({ routes: [first(), second()] })).toThrow(
      'Two controllers are named "Users"',
    );
  });

  test("mounting one controller twice is two controllers of one name", () => {
    const users = controller("Users", () => ({
      list: route({ method: "GET", path: "/", handler: () => [] }),
    }));

    expect(() =>
      createApp({
        routes: [
          group("/v1/users", { children: [users()] }),
          group("/v2/users", { children: [users()] }),
        ],
      }),
    ).toThrow('Two controllers are named "Users"');
  });

  test("two versions are two names over one body", () => {
    const body = () => ({
      list: route({ method: "GET", path: "/", handler: () => [] }),
    });
    const usersV1 = controller("UsersV1", body);
    const usersV2 = controller("UsersV2", body);

    const app = createApp({
      routes: [
        group("/v1/users", { children: [usersV1()] }),
        group("/v2/users", { children: [usersV2()] }),
      ],
    });

    expect(app.entries.map((entry) => entry.controller)).toEqual([
      "UsersV1",
      "UsersV2",
    ]);
  });

  test("is a class's own when it is a class", () => {
    class LegacyController {
      list = route({ method: "GET", path: "/", handler: () => [] });
    }

    const app = createApp({ routes: new LegacyController() });

    expect(app.entries[0]?.controller).toBe("LegacyController");
  });

  test('is absent for an object literal, not "Object"', () => {
    const app = createApp({
      routes: { list: route({ method: "GET", path: "/", handler: () => [] }) },
    });

    expect(app.entries[0]?.controller).toBeUndefined();
    expect(app.entries[0]?.route.controller).toBeUndefined();
  });

  test("two unnamed objects are not two controllers of one name", () => {
    expect(() =>
      createApp({
        routes: [
          { a: route({ method: "GET", path: "/a", handler: () => [] }) },
          { b: route({ method: "GET", path: "/b", handler: () => [] }) },
        ],
      }),
    ).not.toThrow();
  });

  test("names the route in a duplicate route error when there is no name", () => {
    expect(() =>
      createApp({
        routes: [
          { a: route({ method: "GET", path: "/same", handler: () => [] }) },
          { b: route({ method: "GET", path: "/same", handler: () => [] }) },
        ],
      }),
    ).toThrow(
      'Duplicate route: GET /same is defined by both the "a" route of an unnamed controller and the "b" route of an unnamed controller',
    );
  });
});
