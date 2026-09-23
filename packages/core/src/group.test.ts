/**
 * Runtime tests for topology groups.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { group, isGroup } from "./group.ts";
import { hook } from "./hook.ts";

describe("group()", () => {
  test("builds a node carrying prefix, hooks and children", () => {
    const child = { name: "controller" };
    const metrics = hook.beforeParse(() => undefined);

    const node = group("/api", {
      hooks: { beforeParse: [metrics] },
      children: [child],
    });

    expect(node.prefix).toBe("/api");
    expect(node.hooks?.beforeParse).toEqual([metrics]);
    expect(node.children).toEqual([child]);
  });

  test("nests groups as children", () => {
    const inner = group("/admin", { children: [] });
    const outer = group("/api", { children: [inner] });

    expect(isGroup(outer.children[0])).toBe(true);
  });

  const mount = (prefix: string) => group(prefix as "/api", { children: [] });

  test("rejects a prefix without a leading slash", () => {
    expect(() => mount("api")).toThrow('Group prefix must start with "/"');
  });

  test("rejects a bare slash prefix", () => {
    expect(() => mount("/")).toThrow("no-op");
  });

  test("rejects a trailing slash", () => {
    expect(() => mount("/api/")).toThrow('must not end with "/"');
  });

  test("rejects empty segments", () => {
    expect(() => mount("/api//v1")).toThrow("empty segments");
  });

  test("rejects parameters in the prefix", () => {
    expect(() => mount("/tenants/:tenantId")).toThrow(
      'must not declare ":params"',
    );
  });

  test("rejects a wildcard in the prefix", () => {
    expect(() => mount("/api/*")).toThrow('must not contain "*"');
  });
});

describe("isGroup", () => {
  test("accepts group nodes and rejects everything else", () => {
    expect(isGroup(group("/api", { children: [] }))).toBe(true);
    expect(isGroup({ prefix: "/api", children: [] })).toBe(false);
    expect(isGroup(null)).toBe(false);
  });
});
