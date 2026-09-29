/**
 * Tests for the CORS hook, through a live server.
 *
 * The point of a hook package is that it is nothing special: these run it
 * exactly as an application would, mounted in `createApp`.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, HttpError, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { cors } from "./index.ts";

const shared = cors({ origin: "https://app.example.com" });

class ApiController {
  read = route({
    method: "GET",
    path: "/items",
    handler: () => ({ ok: true }),
  });

  fails = route({
    method: "GET",
    path: "/fails",
    handler: () => {
      throw new HttpError(403, { code: "forbidden" });
    },
  });
}

const request = serve(
  createApp({
    hooks: {
      beforeParse: [shared],
    },
    routes: new ApiController(),
  }),
);

const from = (origin: string) => ({ headers: { origin } });

describe("a preflight", () => {
  test("is answered without reaching the route", async () => {
    const res = await request("/items", {
      method: "OPTIONS",
      ...from("https://app.example.com"),
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  test("from an origin that is not allowed carries no headers", async () => {
    const res = await request("/items", {
      method: "OPTIONS",
      ...from("https://evil.example.com"),
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // The preflight hook is what the origin check guards, so the preflight
    // headers are what tell whether it ran. `allow-origin` is written by
    // the other hook and stays null either way, which is why this branch
    // looked covered while the check itself was not.
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
    expect(res.headers.get("access-control-max-age")).toBeNull();
  });
});

describe("an ordinary response", () => {
  test("carries the origin back", async () => {
    const res = await request("/items", from("https://app.example.com"));

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("vary")).toBe("origin");
  });

  test("without an origin header carries no CORS headers, and says it varies", async () => {
    // A cache that stored this answer without `vary: origin` handed it —
    // without `allow-origin` — to the allowed site's next request, and the
    // browser refused it until the entry expired.
    const res = await request("/items");

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("origin");
  });

  test("from an origin that is not allowed says it varies too", async () => {
    const res = await request("/items", from("https://evil.example.com"));

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("origin");
  });

  test("an error response carries them too", async () => {
    const res = await request("/fails", from("https://app.example.com"));

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });

  test("a 404 carries them too", async () => {
    const res = await request("/nothing-here", from("https://app.example.com"));

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });
});

describe("options", () => {
  test("a wildcard origin answers every caller", async () => {
    const open = cors({ origin: "*" });

    const anywhere = serve(
      createApp({
        hooks: {
          beforeParse: [open],
        },
        routes: new ApiController(),
      }),
    );

    const res = await anywhere("/items", from("https://anywhere.example.com"));

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
  });

  test("several origins are matched exactly and echoed", async () => {
    const many = cors({
      origin: ["https://a.example.com", "https://b.example.com"],
    });

    const both = serve(
      createApp({
        hooks: {
          beforeParse: [many],
        },
        routes: new ApiController(),
      }),
    );

    const allowed = await both("/items", from("https://b.example.com"));
    const refused = await both("/items", from("https://c.example.com"));

    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://b.example.com",
    );
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("credentials and exposed headers are advertised", async () => {
    const withCredentials = cors({
      origin: "https://app.example.com",
      credentials: true,
      exposeHeaders: ["x-request-id"],
    });

    const secured = serve(
      createApp({
        hooks: {
          beforeParse: [withCredentials],
        },
        routes: new ApiController(),
      }),
    );

    const res = await secured("/items", from("https://app.example.com"));

    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "x-request-id",
    );
  });

  test("a wildcard with credentials is refused where it is written", () => {
    expect(() => cors({ origin: "*", credentials: true })).toThrow(
      "cannot be combined with credentials",
    );
  });
});

describe("an origin as the browser sends it", () => {
  test.each([
    ["https://app.example.com/", "https://app.example.com"],
    ["https://App.Example.com", "https://app.example.com"],
    ["https://app.example.com/admin", "https://app.example.com"],
    ["https://app.example.com:443", "https://app.example.com"],
  ])("%s is refused, naming the origin it means", (written, meant) => {
    expect(() => cors({ origin: [written] })).toThrow(meant);
  });

  test("something that is not an address at all is refused", () => {
    expect(() => cors({ origin: ["app.example.com"] })).toThrow(
      "app.example.com",
    );
  });

  test("an app or extension scheme is taken as a browser sends it", () => {
    expect(() =>
      cors({
        origin: [
          "chrome-extension://abcdefghijklmnop",
          "capacitor://localhost",
          "tauri://localhost",
        ],
      }),
    ).not.toThrow();
    expect(() => cors({ origin: ["Capacitor://Localhost"] })).toThrow(
      "capacitor://localhost",
    );
    expect(() => cors({ origin: ["capacitor://localhost/"] })).toThrow(
      "capacitor://",
    );
  });

  test("a wildcard in a list, or a pattern, is refused", () => {
    expect(() => cors({ origin: ["*"] })).toThrow('origin: "*"');
    expect(() => cors({ origin: ["https://*.example.com"] })).toThrow(
      "matched whole",
    );
    expect(() => cors({ origin: ["Null"] })).toThrow('"null"');
  });

  test("an origin, and null, are taken as they are", () => {
    expect(() =>
      cors({
        origin: ["https://app.example.com", "http://localhost:5173", "null"],
      }),
    ).not.toThrow();
  });
});

describe("a null origin with credentials", () => {
  test("is refused, as the wildcard is: any site can send it", () => {
    expect(() =>
      cors({ origin: ["https://app.example.com", "null"], credentials: true }),
    ).toThrow(/null/);
    expect(() => cors({ origin: "null", credentials: true })).toThrow(/null/);
  });

  test("without credentials, it is allowed", () => {
    expect(() => cors({ origin: ["null"] })).not.toThrow();
  });
});

describe("a wildcard", () => {
  test("does not vary, since every caller gets the same answer", async () => {
    const open = serve(
      createApp({
        hooks: { beforeParse: [cors({ origin: "*" })] },
        routes: new ApiController(),
      }),
    );

    expect((await open("/items")).headers.get("vary")).toBeNull();
    expect(
      (await open("/items", from("https://app.example.com"))).headers.get(
        "vary",
      ),
    ).toBeNull();
  });
});
