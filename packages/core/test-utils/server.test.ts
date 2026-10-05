/**
 * Tests for how long a server from `serve()` lives, and what using one
 * after it has stopped says.
 *
 * `serve()` registers an `afterAll` where it is called, and Bun runs an
 * `afterAll` registered inside a hook or a test as soon as that hook or
 * test ends. At the end of a test that is the right lifetime; right after
 * a `beforeAll` it stopped the server before any test had used it, and
 * every request failed with a bare `ConnectionRefused`.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, route } from "../src/index.ts";
import type { RequestFn } from "./server.ts";
import { serve, stopServers } from "./server.ts";

const app = createApp({
  routes: route({ method: "GET", path: "/", handler: () => ({ ok: true }) }),
});

describe("a server started in beforeAll", () => {
  let request: RequestFn;

  beforeAll(async () => {
    await Bun.sleep(1);

    request = serve(app);
  });

  // The afterAll serve() registered ran when the hook returned. Should Bun
  // ever keep it to the end of the describe, this is the test that says so.
  test("has stopped before the first test, and a request says why", async () => {
    await expect(request("/")).rejects.toThrow(
      "right after a beforeAll that calls serve()",
    );
  });
});

describe("an afterAll registered after serve()", () => {
  const told: string[] = [];

  describe("with a teardown that still needs the server", () => {
    const request = serve(app);

    afterAll(async () => {
      try {
        await request("/");

        told.push("answered");
      } catch (error) {
        told.push((error as Error).message);
      }
    });

    test("serves the tests", async () => {
      expect((await request("/")).status).toBe(200);
    });
  });

  // Bun runs afterAll hooks in the order they were registered, and the one
  // serve() registers comes first. Should that change, this test says so.
  test("runs once the server has stopped, and is told so", () => {
    expect(told).toEqual([
      expect.stringContaining("before an afterAll registered after serve()"),
    ]);
  });
});

describe("a server started in beforeAll with { stop: false }", () => {
  let request: RequestFn;

  beforeAll(async () => {
    await Bun.sleep(1);

    request = serve(app, { stop: false });
  });

  afterAll(() => request.stop());

  test("serves the tests of the describe", async () => {
    expect((await request("/")).status).toBe(200);
  });

  test("every one of them", async () => {
    expect((await request("/")).status).toBe(200);
  });
});

describe("a server stopped with request.stop()", () => {
  test("refuses a request, saying so", async () => {
    const request = serve(app);

    request.stop();

    await expect(request("/")).rejects.toThrow("request.stop() stopped it");
  });

  // Bun works out `server.url` when it is first read, and a stopped server
  // reads as port 0: a server nothing reached was named `localhost:0`.
  test("names the port it listened on, though nothing reached it", async () => {
    const request = serve(app);

    request.stop();

    await expect(request("/")).rejects.toThrow(
      /the server at http:\/\/localhost:[1-9]\d* has stopped/,
    );
  });

  test("refuses its url, which a WebSocket would connect to", () => {
    const request = serve(app);

    request.stop();

    expect(() => request.url).toThrow("request.stop() stopped it");
  });

  test("refuses a request from a client made before the stop", async () => {
    const request = serve(app);
    const client = request.client();

    request.stop();

    await expect(client("/")).rejects.toThrow("request.stop() stopped it");
  });
});

describe("the request function", () => {
  test("keeps its members replaceable, so a test can stub one", () => {
    const request = serve(app);

    request.client = () => {
      throw new Error("stubbed");
    };

    expect(() => request.client()).toThrow("stubbed");
  });
});

// Last in the file: stopServers() stops every server serve() started.
describe("stopServers()", () => {
  test("stops a server left to the caller, and a request says so", async () => {
    const request = serve(app, { stop: false });

    expect((await request("/")).status).toBe(200);

    stopServers();

    await expect(request("/")).rejects.toThrow("stopServers() stopped it");
  });
});
