/**
 * Runtime tests for lifecycle hook factories.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { hook, stack } from "./hook.ts";

const callHook = (target: { fn: unknown }, ctx: unknown) =>
  (target.fn as (ctx: unknown) => unknown)(ctx);

describe("hook factories", () => {
  test("bind the function to its slot", () => {
    const noop = hook.beforeParse(() => undefined);

    expect(noop.slot).toBe("beforeParse");
    expect(typeof noop.fn).toBe("function");
  });

  test("keep the function callable as passed", async () => {
    const auth = hook.beforeParse(() => ({ user: { id: "42" } }));

    const result = await callHook(auth, {});

    expect(result).toEqual({ user: { id: "42" } });
  });

  test("create a distinct hook object per call", () => {
    const first = hook.onError(() => undefined);
    const second = hook.onError(() => undefined);

    expect(first).not.toBe(second);
    expect(first.slot).toBe("onError");
  });
});

describe("stack", () => {
  test("returns the hooks in the given order", () => {
    const a = hook.beforeParse(() => undefined);
    const b = hook.beforeHandle(() => undefined);

    const secured = stack(a, b);

    expect(secured).toEqual([a, b]);
  });
});
