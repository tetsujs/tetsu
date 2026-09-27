/**
 * Integration tests: the test client, its headers and its cookie jar.
 *
 * The jar is checked against what a server of this framework actually
 * sends — `ctx.out.cookies`, signing included — and against raw
 * `set-cookie` headers for what the framework never writes itself, such as
 * a cookie without a `Path`.
 *
 * @module
 */

import { describe, expect, setSystemTime, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { route } from "../src/route.ts";
import type { StandardSchemaV1 } from "../src/schema.ts";
import { serve } from "./server.ts";

/** Passes the cookies through untouched, so a handler can echo them. */
const AsIs: StandardSchemaV1<unknown, Record<string, string>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as Record<string, string> }),
  },
};

const request = serve(
  createApp({
    cookies: { secret: "top-secret", sign: ["session"] },
    routes: {
      login: route({
        method: "POST",
        path: "/login",
        bodyType: "text",
        handler: (ctx) => {
          ctx.out.cookies.set("session", ctx.body, { httpOnly: true });
          ctx.out.cookies.set("theme", "dark mode; really");
        },
      }),

      logout: route({
        method: "POST",
        path: "/logout",
        handler: (ctx) => {
          ctx.out.cookies.delete("session");
        },
      }),

      raw: route({
        method: "POST",
        path: "/raw",
        bodyType: "text",
        handler: (ctx) => {
          ctx.out.headers.append("set-cookie", ctx.body);
        },
      }),

      nested: route({
        method: "POST",
        path: "/admin/panel",
        handler: (ctx) => {
          ctx.out.headers.append("set-cookie", "scoped=1");
        },
      }),

      me: route({
        method: "GET",
        path: "/*",
        schema: { cookies: AsIs },
        handler: (ctx) => ({
          cookies: ctx.cookies,
          header: ctx.req.headers.get("cookie"),
        }),
      }),

      echo: route({
        method: "POST",
        path: "/echo",
        bodyType: "text",
        handler: (ctx) => ({
          body: ctx.body,
          type: ctx.req.headers.get("content-type"),
          ip: ctx.req.headers.get("x-real-ip"),
          captcha: ctx.req.headers.get("x-captcha-token"),
        }),
      }),

      away: route({
        method: "GET",
        path: "/away",
        handler: (ctx) => {
          ctx.out.cookies.set("visited", "yes");

          return new Response(null, {
            status: 302,
            headers: { location: "/home" },
          });
        },
      }),
    },
  }),
);

interface Seen {
  readonly cookies: Record<string, string>;
  readonly header: string | null;
}

describe("the cookie jar", () => {
  test("keeps every cookie a response sets and sends them back", async () => {
    const client = request.client();

    await client("/login", { method: "POST", body: "alice" });

    const seen = (await (await client("/me")).json()) as Seen;

    expect(seen.cookies).toEqual({
      session: "alice",
      theme: "dark mode; really",
    });
  });

  test("holds a signed cookie opaquely, with its signature", async () => {
    const client = request.client();

    await client("/login", { method: "POST", body: "alice" });

    expect(client.cookies.get("session")).toStartWith("alice.");
    expect(client.cookies.get("theme")).toBe("dark mode; really");
  });

  test("a forged signature reads as absent", async () => {
    const client = request.client();

    client.cookies.set("session", "alice.forged");

    const seen = (await (await client("/me")).json()) as Seen;

    expect(seen.cookies).toEqual({});
  });

  test("a value set in the jar arrives as the application wrote it", async () => {
    const client = request.client();

    client.cookies.set("theme", "dark mode; really");

    const seen = (await (await client("/me")).json()) as Seen;

    expect(seen.cookies).toEqual({ theme: "dark mode; really" });
    expect(client.cookies.get("theme")).toBe("dark mode; really");
  });

  test("deleting a cookie on the server removes it from the jar", async () => {
    const client = request.client();

    await client("/login", { method: "POST", body: "alice" });
    await client("/logout", { method: "POST" });

    expect(client.cookies.get("session")).toBeUndefined();

    const seen = (await (await client("/me")).json()) as Seen;

    expect(Object.keys(seen.cookies)).toEqual(["theme"]);
  });

  test.each([
    [
      "an Expires in the past",
      "theme=light; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
    ],
    ["an empty value", "theme=; Path=/"],
    ["a negative Max-Age", "theme=light; Path=/; Max-Age=-1"],
  ])("%s removes the cookie", async (_, setCookie) => {
    const client = request.client();

    await client("/login", { method: "POST", body: "alice" });
    await client("/raw", { method: "POST", body: setCookie });

    expect(client.cookies.get("theme")).toBeUndefined();
  });

  test("a cookie whose Max-Age has passed is not sent", async () => {
    const client = request.client();

    await client("/raw", {
      method: "POST",
      body: "brief=1; Path=/; Max-Age=1",
    });

    expect(client.cookies.get("brief")).toBe("1");

    setSystemTime(new Date(Date.now() + 1_001));

    const res = await client("/me").finally(() => setSystemTime());

    const seen = (await res.json()) as Seen;

    expect(seen.header).toBeNull();
    expect(client.cookies.get("brief")).toBeUndefined();
  });

  test("sends a cookie only under its Path", async () => {
    const client = request.client();

    await client("/raw", { method: "POST", body: "zone=a; Path=/admin" });

    const under = (await (await client("/admin/users")).json()) as Seen;
    const at = (await (await client("/admin")).json()) as Seen;
    const beside = (await (await client("/administrator")).json()) as Seen;
    const outside = (await (await client("/public")).json()) as Seen;

    expect(under.header).toBe("zone=a");
    expect(at.header).toBe("zone=a");
    expect(beside.header).toBeNull();
    expect(outside.header).toBeNull();
  });

  test("a cookie without a Path is scoped to the directory that set it", async () => {
    const client = request.client();

    await client("/admin/panel", { method: "POST" });

    const inside = (await (await client("/admin/users")).json()) as Seen;
    const outside = (await (await client("/users")).json()) as Seen;

    expect(inside.header).toBe("scoped=1");
    expect(outside.header).toBeNull();
  });

  test("one name under two paths is two cookies, the longer path first", async () => {
    const client = request.client();

    await client("/raw", { method: "POST", body: "zone=root; Path=/" });
    await client("/raw", { method: "POST", body: "zone=admin; Path=/admin" });

    const seen = (await (await client("/admin/x")).json()) as Seen;

    expect(seen.header).toBe("zone=admin; zone=root");
    expect(client.cookies.get("zone")).toBe("admin");

    client.cookies.delete("zone");

    expect(client.cookies.get("zone")).toBeUndefined();
  });

  test("a redirect is answered, and the cookie it sets is kept", async () => {
    const client = request.client();

    const res = await client("/away");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
    expect(client.cookies.get("visited")).toBe("yes");
  });

  test("clients do not share a jar", async () => {
    const alice = request.client();
    const bob = request.client();

    await alice("/login", { method: "POST", body: "alice" });

    expect(bob.cookies.get("session")).toBeUndefined();
  });

  test("a cookie: null request goes without the jar", async () => {
    const client = request.client();

    await client("/login", { method: "POST", body: "alice" });

    const seen = (await (
      await client("/me", { headers: { cookie: null } })
    ).json()) as Seen;

    expect(seen.header).toBeNull();
  });
});

describe("the client's requests", () => {
  interface Echo {
    readonly body: string;
    readonly type: string | null;
    readonly ip: string | null;
    readonly captcha: string | null;
  }

  test("json is serialized and sent as application/json", async () => {
    const client = request.client();

    const echo = (await (
      await client("/echo", { method: "POST", json: { email: "a@b.c" } })
    ).json()) as Echo;

    expect(echo.body).toBe('{"email":"a@b.c"}');
    expect(echo.type).toBe("application/json");
  });

  test("body goes on the wire as is", async () => {
    const client = request.client();

    const echo = (await (
      await client("/echo", {
        method: "POST",
        body: "{bad",
        headers: { "content-type": "application/json" },
      })
    ).json()) as Echo;

    expect(echo.body).toBe("{bad");
    expect(echo.type).toBe("application/json");
  });

  test("the client's headers go with every request", async () => {
    const client = request.client({
      headers: { "X-Real-IP": "10.0.0.7", "x-captcha-token": "ok" },
    });

    const echo = (await (
      await client("/echo", { method: "POST", body: "" })
    ).json()) as Echo;

    expect(echo.ip).toBe("10.0.0.7");
    expect(echo.captcha).toBe("ok");
  });

  test("a request's header replaces the client's, and null removes it", async () => {
    const client = request.client({
      headers: { "x-real-ip": "10.0.0.7", "x-captcha-token": "ok" },
    });

    const echo = (await (
      await client("/echo", {
        method: "POST",
        body: "",
        headers: { "x-real-ip": "10.0.0.8", "X-Captcha-Token": null },
      })
    ).json()) as Echo;

    expect(echo.ip).toBe("10.0.0.8");
    expect(echo.captcha).toBeNull();
  });

  test("a request's content-type replaces the one json implies", async () => {
    const client = request.client();

    const echo = (await (
      await client("/echo", {
        method: "POST",
        json: [{ op: "remove", path: "/a" }],
        headers: { "content-type": "application/json-patch+json" },
      })
    ).json()) as Echo;

    expect(echo.type).toBe("application/json-patch+json");
  });

  test("json and body do not go together", () => {
    const client = request.client();

    const both = () =>
      // @ts-expect-error one body or the other
      client("/echo", { method: "POST", json: {}, body: "{}" });

    expect(both).toBeFunction();
  });
});
