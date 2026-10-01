/**
 * Runtime tests for WebSocket endpoint definition.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { ws } from "./ws.ts";

describe("ws() path validation", () => {
  const define = (path: string) => ws({ path: path as "/" });

  test("rejects what route() rejects", () => {
    expect(() => define("chat")).toThrow('must start with "/"');
    expect(() => define("/a//b")).toThrow("empty segments");
    expect(() => define("/chat/")).toThrow('must not end with "/"');
    expect(() => define("/chat/{id}")).toThrow();
    expect(() => define("/chat/:")).toThrow("must have a name");
    expect(() => define("/files/*/x")).toThrow("entire final segment");
  });

  test("accepts the root, parameters and a final wildcard", () => {
    expect(define("/").path).toBe("/");
    expect(ws({ path: "/rooms/:id" }).path).toBe("/rooms/:id");
    expect(ws({ path: "/feeds/*" }).path).toBe("/feeds/*");
  });
});
