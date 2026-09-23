/**
 * Runtime tests for route definition.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { hook } from "./hook.ts";
import { isRoute, route } from "./route.ts";

const probe = route({
  method: "GET",
  path: "/probe/:id",
  handler: (ctx) => ({ id: ctx.params.id }),
});

describe("route()", () => {
  test("preserves the config on the definition", () => {
    expect(probe.method).toBe("GET");
    expect(probe.path).toBe("/probe/:id");
    expect(typeof probe.handler).toBe("function");
  });

  test("preserves hooks as given", () => {
    const noop = hook.beforeParse(() => undefined);

    const withHooks = route({
      method: "GET",
      path: "/hooked",
      hooks: { beforeParse: [noop] },
      handler: () => undefined,
    });

    expect(withHooks.hooks?.beforeParse).toEqual([noop]);
  });

  test("keeps the handler callable", () => {
    const call = probe.handler as (ctx: unknown) => unknown;

    expect(call({ params: { id: "7" } })).toEqual({ id: "7" });
  });
});

describe("route() path validation", () => {
  const define = (path: string) =>
    route({ method: "GET", path: path as "/", handler: () => undefined });

  test("rejects a path without a leading slash", () => {
    expect(() => define("orders")).toThrow('must start with "/"');
  });

  test("rejects empty segments", () => {
    expect(() => define("/a//b")).toThrow("empty segments");
    expect(() => define("////")).toThrow("empty segments");
  });

  test("rejects a trailing slash", () => {
    expect(() => define("/orders/")).toThrow('must not end with "/"');
  });

  test("accepts the bare root path", () => {
    expect(define("/").path).toBe("/");
  });

  test("rejects a parameter that shares its segment", () => {
    expect(() => define("/a/:b-:c")).toThrow("must span a whole segment");
    expect(() => define("/files/:name.:ext")).toThrow("whole segment");
    expect(() => define("/rpc/foo:bar")).toThrow("whole segment");
  });

  test("rejects a parameter with no name", () => {
    expect(() => define("/a/:")).toThrow("must have a name");
    expect(() => define("/:")).toThrow("must have a name");
    expect(() => define("/a/:/b")).toThrow("must have a name");
  });

  test("accepts wildcards and well-formed parameters", () => {
    expect(
      route({ method: "GET", path: "/files/*", handler: () => undefined }).path,
    ).toBe("/files/*");
    expect(
      route({ method: "GET", path: "/a/:b/c/:d", handler: () => undefined })
        .path,
    ).toBe("/a/:b/c/:d");
  });

  test("rejects a wildcard that is not the entire final segment", () => {
    expect(() => define("/a/*/b")).toThrow("entire final segment");
    expect(() => define("/files/*rest")).toThrow("entire final segment");
    expect(() => define("/files/a*")).toThrow("entire final segment");
  });

  test("rejects optional-parameter syntax the router does not have", () => {
    expect(() => define("/opt/:id?")).toThrow("no optional parameters");
  });

  test("rejects a parameter spelled the way OpenAPI spells it", () => {
    expect(() => define("/users/{id}")).toThrow('A parameter is ":id"');
    expect(() => define("/users/{id}/items")).toThrow('A parameter is ":id"');
    expect(() => define("/a/}")).toThrow('A parameter is ":id"');
  });

  test("names the rule the compiler names, when a path breaks two", () => {
    // `ValidatePath` checks `?` and braces over the whole path first, then
    // walks the segments left to right; `path.test-d.ts` pins the same
    // paths. A path only reaches this check past the compiler, so the
    // error it gets at startup is the one it was already shown.
    expect(() => define("/a*/b:c")).toThrow("entire final segment");
    expect(() => define("/a:b/c*")).toThrow("whole segment");
    expect(() => define("/:/a:b")).toThrow("must have a name");
    expect(() => define("/a*/:id?")).toThrow("no optional parameters");
    expect(() => define("/a*/{id}")).toThrow('A parameter is ":id"');
  });
});

describe("isRoute", () => {
  test("accepts route definitions", () => {
    expect(isRoute(probe)).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isRoute({})).toBe(false);
    expect(isRoute(null)).toBe(false);
    expect(isRoute("route")).toBe(false);
    expect(isRoute({ method: "GET", path: "/x", handler: () => 1 })).toBe(
      false,
    );
  });
});
