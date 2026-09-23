/**
 * Unit tests for the per-request context shapes.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { OutgoingSettings } from "./context.ts";

describe("OutgoingSettings", () => {
  test("creates the Headers instance only on first access", () => {
    const out = new OutgoingSettings();

    expect(out.createdHeaders).toBeUndefined();

    out.headers.set("x-request-id", "rid-1");

    expect(out.createdHeaders?.get("x-request-id")).toBe("rid-1");
  });

  test("hands out the same instance on every access", () => {
    const out = new OutgoingSettings();

    out.headers.set("x-first", "1");
    out.headers.append("x-second", "2");

    expect(out.createdHeaders?.get("x-first")).toBe("1");
    expect(out.createdHeaders?.get("x-second")).toBe("2");
  });

  test("carries no status until something sets one", () => {
    const out = new OutgoingSettings();

    expect(out.status).toBeUndefined();

    out.status = 201;

    expect(out.status).toBe(201);
  });
});
