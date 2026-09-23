/**
 * Integration tests: the framework's body limit against Bun's own.
 *
 * `Bun.serve` refuses an oversized body before any of this runs, with a
 * bare `413` rather than the framework's envelope. An application that
 * allows more than Bun does by default therefore has to raise Bun's cap
 * too — and carrying that on the app is what keeps the number in one
 * place.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp } from "./app.ts";
import { route } from "./route.ts";

const mib = 1024 * 1024;

/** One route that reports how much body it read. */
const sized = {
  up: route({
    method: "POST",
    path: "/up",
    bodyType: "text",
    handler: (ctx) => ({ length: (ctx.body as string).length }),
  }),
};

describe("the cap carried on the app", () => {
  test("is absent while the application allows less than Bun does", () => {
    const modest = createApp({ maxBodySize: 4 * mib, routes: sized });

    // Bun's default is already far above; saying anything would only risk
    // lowering it.
    expect(modest.maxRequestBodySize).toBeUndefined();
    expect("maxRequestBodySize" in modest).toBe(false);
  });

  test("appears, above the application's own, once it allows more", () => {
    const generous = createApp({ maxBodySize: 200 * mib, routes: sized });

    expect(generous.maxRequestBodySize).toBeGreaterThan(200 * mib);
  });

  test("reaches Bun through the ordinary spread", async () => {
    const generous = createApp({ maxBodySize: 200 * mib, routes: sized });

    const server = Bun.serve({ ...generous, port: 0 });

    const res = await fetch(`${server.url.href}up`, {
      method: "POST",
      body: "x".repeat(140 * mib),
    });

    // Without the carried cap this is Bun's bare 413, before the pipeline.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 140 * mib });

    server.stop(true);
  }, 120_000);

  test("the framework's limit still fires first, with its own envelope", async () => {
    const generous = createApp({ maxBodySize: 200 * mib, routes: sized });

    const server = Bun.serve({ ...generous, port: 0 });

    const res = await fetch(`${server.url.href}up`, {
      method: "POST",
      body: "x".repeat(201 * mib),
    });

    // The margin is what buys this: equal caps would be a race, and Bun
    // winning means a status with an empty body.
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });

    server.stop(true);
  }, 120_000);

  test("a value after the spread still wins, because that is what spreading means", async () => {
    const generous = createApp({ maxBodySize: 200 * mib, routes: sized });

    const server = Bun.serve({
      ...generous,
      maxRequestBodySize: 1024,
      port: 0,
    });

    const res = await fetch(`${server.url.href}up`, {
      method: "POST",
      body: "y".repeat(4096),
    });

    expect(res.status).toBe(413);

    server.stop(true);
  });
});
