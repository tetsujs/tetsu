/**
 * Tests for `onMount`: the application handed back to the controllers that
 * asked for it.
 *
 * @module
 */

import { describe, expect, spyOn, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import type { App } from "./app.ts";
import { createApp } from "./app.ts";
import { group } from "./group.ts";
import { onMount } from "./mount.ts";
import { route } from "./route.ts";

class RoutesController {
  private app: App | undefined;

  [onMount](app: App): void {
    this.app = app;
  }

  list = route({
    method: "GET",
    path: "/routes",
    handler: () => this.app?.entries.map((entry) => entry.path) ?? [],
  });
}

describe("a controller that asks for its application", () => {
  test("receives it, and sees the whole table including itself", async () => {
    const request = serve(
      createApp({
        routes: [
          group("/api", {
            children: [
              {
                health: route({
                  method: "GET",
                  path: "/health",
                  handler: () => "ok",
                }),
              },
            ],
          }),
          new RoutesController(),
        ],
      }),
    );

    expect(await (await request("/routes")).json()).toEqual([
      "/api/health",
      "/routes",
    ]);
  });

  test("is handed the application before anything is served", () => {
    let seen: App | undefined;

    const app = createApp({
      routes: {
        [onMount](mounted: App) {
          seen = mounted;
        },
        ping: route({ method: "GET", path: "/ping", handler: () => "pong" }),
      },
    });

    expect(seen).toBe(app);
  });

  test("is called once, however many times it is mounted", () => {
    let calls = 0;

    const controller = {
      [onMount]() {
        calls += 1;
      },
      ping: route({ method: "GET", path: "/ping", handler: () => "pong" }),
    };

    createApp({
      routes: [
        group("/a", { children: [controller] }),
        group("/b", { children: [controller] }),
      ],
    });

    expect(calls).toBe(1);
  });

  test("needs no routes of its own to be mounted", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      let seen: App | undefined;

      createApp({
        routes: [
          {
            [onMount](app: App) {
              seen = app;
            },
          },
          {
            ping: route({ method: "GET", path: "/ping", handler: () => "ok" }),
          },
        ],
      });

      expect(seen).toBeDefined();
      expect(warn.mock.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a controller with neither routes nor onMount is still a mistake", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      createApp({ routes: { helper: () => "not a route" } });

      const warned = warn.mock.calls.map((call) => String(call[0]));

      expect(warned.join()).toContain("defines no routes");
    } finally {
      warn.mockRestore();
    }
  });
});
