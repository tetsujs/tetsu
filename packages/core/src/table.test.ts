/**
 * Runtime tests for route table compilation.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import { buildRouteTable } from "./table.ts";
import { ws } from "./ws.ts";

class UsersController {
  list = route({ method: "GET", path: "/users", handler: () => [] });

  create = route({ method: "POST", path: "/users", handler: () => ({}) });

  notARoute = "just a field";
}

class HealthController {
  live = route({ method: "GET", path: "/", handler: () => ({ ok: true }) });
}

describe("buildRouteTable", () => {
  test("collects routes from controller fields, ignoring the rest", () => {
    const { entries, warnings } = buildRouteTable({
      routes: new UsersController(),
    });

    expect(entries.map((e) => `${e.method} ${e.path}`)).toEqual([
      "GET /users",
      "POST /users",
    ]);
    expect(entries[0]?.controller).toBe("UsersController");
    expect(warnings).toEqual([]);
  });

  test("joins prefixes through nested groups", () => {
    const { entries } = buildRouteTable({
      routes: group("/api/v1", {
        children: [group("/admin", { children: [new UsersController()] })],
      }),
    });

    expect(entries[0]?.path).toBe("/api/v1/admin/users");
  });

  test("mounts a root route onto its group prefix", () => {
    const { entries } = buildRouteTable({
      routes: group("/health", { children: [new HealthController()] }),
    });

    expect(entries[0]?.path).toBe("/health");
  });

  test("merges hook chains in app → outer → inner → route order", () => {
    const appHook = hook.beforeParse(() => undefined);
    const outerHook = hook.beforeParse(() => undefined);
    const innerHook = hook.beforeParse(() => undefined);
    const routeHook = hook.beforeParse(() => undefined);

    class Controller {
      probe = route({
        method: "GET",
        path: "/probe",
        hooks: { beforeParse: [routeHook] },
        handler: () => undefined,
      });
    }

    const { entries } = buildRouteTable({
      hooks: { beforeParse: [appHook] },
      routes: group("/outer", {
        hooks: { beforeParse: [outerHook] },
        children: [
          group("/inner", {
            hooks: { beforeParse: [innerHook] },
            children: [new Controller()],
          }),
        ],
      }),
    });

    expect(entries[0]?.hooks.beforeParse).toEqual([
      appHook,
      outerHook,
      innerHook,
      routeHook,
    ]);
    expect(entries[0]?.hooks.beforeHandle).toEqual([]);
  });

  test("composes onError innermost-first so specific handlers win", () => {
    const appHook = hook.onError(() => undefined);
    const groupHook = hook.onError(() => undefined);
    const routeHook = hook.onError(() => undefined);

    class Controller {
      probe = route({
        method: "GET",
        path: "/probe",
        hooks: { onError: [routeHook] },
        handler: () => undefined,
      });
    }

    const { entries } = buildRouteTable({
      hooks: { onError: [appHook] },
      routes: group("/zone", {
        hooks: { onError: [groupHook] },
        children: [new Controller()],
      }),
    });

    expect(entries[0]?.hooks.onError).toEqual([routeHook, groupHook, appHook]);
  });

  test("a controller is any object with route fields, not only a class", () => {
    const literal = {
      list: route({ method: "GET", path: "/things", handler: () => [] }),
      helper: () => "not a route",
    };

    const { entries, warnings } = buildRouteTable({ routes: literal });

    expect(entries.map((entry) => entry.path)).toEqual(["/things"]);
    expect(entries[0]?.name).toBe("list");
    expect(warnings).toEqual([]);
  });

  test("keeps the controller field a route was declared as", () => {
    const { entries } = buildRouteTable({ routes: new UsersController() });

    expect(entries.map((entry) => entry.name)).toEqual(["list", "create"]);
  });

  test("a standalone route has no field to be named by", () => {
    const standalone = route({
      method: "GET",
      path: "/ping",
      handler: () => ({}),
    });

    const { entries } = buildRouteTable({ routes: standalone });

    expect(entries[0]?.name).toBeUndefined();
    expect(entries[0]?.controller).toBe("(standalone)");
  });

  test("throws on duplicate method + path naming both controllers", () => {
    class First {
      users = route({ method: "GET", path: "/users", handler: () => [] });
    }

    class Second {
      users = route({ method: "GET", path: "/users", handler: () => [] });
    }

    expect(() =>
      buildRouteTable({ routes: [new First(), new Second()] }),
    ).toThrow(
      'Duplicate route: GET /users is defined by both "First" and "Second"',
    );
  });

  test("throws when two paths differ only in parameter names", () => {
    class Reader {
      byId = route({
        method: "GET",
        path: "/users/:id",
        handler: () => ({}),
      });
    }

    class Writer {
      update = route({
        method: "POST",
        path: "/users/:userId",
        handler: () => ({}),
      });
    }

    expect(() =>
      buildRouteTable({ routes: [new Reader(), new Writer()] }),
    ).toThrow(
      'Conflicting routes: "/users/:id" from "Reader" and "/users/:userId" from "Writer" differ only in parameter names',
    );
  });

  test("throws on colliding shapes under the same method", () => {
    class Early {
      byId = route({
        method: "GET",
        path: "/orders/:orderId",
        handler: () => ({}),
      });
    }

    class Late {
      byId = route({
        method: "GET",
        path: "/orders/:oid",
        handler: () => ({}),
      });
    }

    expect(() =>
      buildRouteTable({ routes: [new Early(), new Late()] }),
    ).toThrow("Conflicting routes:");
  });

  test("throws when a group prefix makes two shapes collide", () => {
    class Reader {
      byId = route({ method: "GET", path: "/:id", handler: () => ({}) });
    }

    class Writer {
      byKey = route({ method: "PUT", path: "/:key", handler: () => ({}) });
    }

    expect(() =>
      buildRouteTable({
        routes: group("/items", {
          children: [new Reader(), new Writer()],
        }),
      }),
    ).toThrow("Conflicting routes:");
  });

  test("allows different shapes that share a prefix", () => {
    class Mixed {
      byId = route({ method: "GET", path: "/users/:id", handler: () => ({}) });
      posts = route({
        method: "GET",
        path: "/users/:id/posts",
        handler: () => ({}),
      });
      search = route({
        method: "GET",
        path: "/users/search",
        handler: () => ({}),
      });
    }

    expect(buildRouteTable({ routes: new Mixed() }).entries).toHaveLength(3);
  });

  test("allows the same path under different methods", () => {
    const { entries } = buildRouteTable({ routes: new UsersController() });

    expect(entries).toHaveLength(2);
  });

  test("warns about a controller without routes", () => {
    class Empty {}

    const { entries, warnings } = buildRouteTable({ routes: new Empty() });

    expect(entries).toEqual([]);
    expect(warnings[0]).toContain('"Empty" defines no routes');
  });

  test("rejects a controller class passed instead of an instance", () => {
    expect(() => buildRouteTable({ routes: UsersController })).toThrow(
      'use "new UsersController(...)"',
    );
  });

  test("rejects mounting an application as a child", () => {
    const app = createApp({ routes: [] });

    expect(() => buildRouteTable({ routes: app })).toThrow(
      "cannot be mounted as a child",
    );
  });

  test("refuses a route declared with get, which is typed but never served", () => {
    class GhostController {
      plain = route({ method: "GET", path: "/plain", handler: () => "ok" });

      get viaGetter() {
        return route({
          method: "GET",
          path: "/via-getter",
          handler: () => "no",
        });
      }
    }

    expect(() => buildRouteTable({ routes: new GhostController() })).toThrow(
      'declares "viaGetter" with "get"',
    );
  });

  test("the same for a socket endpoint", () => {
    class GhostSocketController {
      get chat() {
        return ws({ path: "/chat", message: () => undefined });
      }
    }

    expect(() =>
      buildRouteTable({ routes: new GhostSocketController() }),
    ).toThrow('declares "chat" with "get"');
  });

  test("inherited from a base class it is refused too", () => {
    class Base {
      get inherited() {
        return route({
          method: "GET",
          path: "/inherited",
          handler: () => "no",
        });
      }
    }

    class ChildController extends Base {
      plain = route({ method: "GET", path: "/plain", handler: () => "ok" });
    }

    expect(() => buildRouteTable({ routes: new ChildController() })).toThrow(
      'declares "inherited" with "get"',
    );
  });

  test("a getter in an object literal is own and enumerable, so it serves", () => {
    const table = buildRouteTable({
      routes: {
        plain: route({ method: "GET", path: "/plain", handler: () => "ok" }),

        get literal() {
          return route({
            method: "GET",
            path: "/literal",
            handler: () => "ok",
          });
        },
      },
    });

    expect(table.entries.map((entry) => entry.path).toSorted()).toEqual([
      "/literal",
      "/plain",
    ]);
  });

  test("a getter that returns something else is left alone", () => {
    class LabelledController {
      plain = route({ method: "GET", path: "/plain", handler: () => "ok" });

      get label() {
        return "labelled";
      }
    }

    expect(
      buildRouteTable({ routes: new LabelledController() }).entries,
    ).toHaveLength(1);
  });

  test("a getter that throws is not this check's to report", () => {
    class BrokenController {
      plain = route({ method: "GET", path: "/plain", handler: () => "ok" });

      get broken(): never {
        throw new Error("not the framework's business");
      }
    }

    expect(
      buildRouteTable({ routes: new BrokenController() }).entries,
    ).toHaveLength(1);
  });

  test("a controller is not one for having the same field names", () => {
    class ProxyController {
      // The names the check used to look for, as a route and as a helper.
      routes = route({ method: "GET", path: "/routes", handler: () => [] });
      fetch = (url: string) => globalThis.fetch(url);
    }

    const table = buildRouteTable({ routes: new ProxyController() });

    expect(table.entries.map((entry) => entry.path)).toEqual(["/routes"]);
  });

  test("nor for inheriting them from a base class", () => {
    class Base {
      protected routes(): string[] {
        return [];
      }

      protected fetch(): undefined {
        return undefined;
      }
    }

    class ItemsController extends Base {
      list = route({ method: "GET", path: "/items", handler: () => [] });
    }

    const table = buildRouteTable({ routes: new ItemsController() });

    expect(table.entries.map((entry) => entry.path)).toEqual(["/items"]);
  });

  test("registers a standalone RouteDef child", () => {
    const ping = route({ method: "GET", path: "/ping", handler: () => "pong" });

    const { entries } = buildRouteTable({ routes: [ping] });

    expect(entries[0]?.path).toBe("/ping");
    expect(entries[0]?.controller).toBe("(standalone)");
  });
});
