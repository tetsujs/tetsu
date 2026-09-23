/**
 * Integration tests: cookies through a live server.
 *
 * Cookies are the fifth request part, validated by the same phase as the
 * other four, and the only one with a side that leaves rather than
 * arrives. Both sides go over a real socket here, because the header is
 * the contract and nothing below it is.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

/** Passes the record through untouched, so a test can inspect it raw. */
const AsIs: StandardSchemaV1<unknown, Record<string, string>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as Record<string, string> }),
  },
};

const Session: StandardSchemaV1<unknown, { session: string; theme: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const carried = value as { session?: unknown; theme?: unknown };

      if (typeof carried.session !== "string") {
        return {
          issues: [{ message: "session is required", path: ["session"] }],
        };
      }

      return {
        value: {
          session: carried.session,
          theme: typeof carried.theme === "string" ? carried.theme : "light",
        },
      };
    },
  },
};

const fromElsewhere = hook.beforeParse(() => ({
  cookies: { session: "from-hook", theme: "dark" },
}));

class CookieController {
  me = route({
    method: "GET",
    path: "/me",
    schema: { cookies: Session },
    handler: (ctx) => ({
      session: ctx.cookies.session,
      theme: ctx.cookies.theme,
    }),
  });

  bare = route({
    method: "GET",
    path: "/bare",
    handler: (ctx) => ({ present: "cookies" in (ctx as object) }),
  });

  polluted = route({
    method: "GET",
    path: "/polluted",
    schema: { cookies: AsIs },
    handler: (ctx) => ({
      own: Object.hasOwn(ctx.cookies, "__proto__"),
      value:
        Object.getOwnPropertyDescriptor(ctx.cookies, "__proto__")?.value ??
        null,
      prototypeMoved: Object.getPrototypeOf(ctx.cookies) !== null,
    }),
  });

  normalized = route({
    method: "GET",
    path: "/normalized",
    hooks: { beforeParse: [fromElsewhere] },
    schema: { cookies: Session },
    handler: (ctx) => ({ session: ctx.cookies.session }),
  });

  login = route({
    method: "POST",
    path: "/login",
    handler: (ctx) => {
      ctx.out.cookies.set("session", "user-42", {
        httpOnly: true,
        maxAge: 60,
        path: "/",
      });
      ctx.out.cookies.set("theme", "dark");

      return { ok: true };
    },
  });

  rewritten = route({
    method: "POST",
    path: "/rewritten",
    handler: (ctx) => {
      ctx.out.cookies.set("session", "first");
      ctx.out.cookies.set("theme", "dark");
      ctx.out.cookies.set("session", "second");

      return { ok: true };
    },
  });

  staged = route({
    method: "POST",
    path: "/staged",
    handler: (ctx) => {
      ctx.out.cookies.set("session", "never-sent");
      ctx.out.cookies.delete("session");

      return { ok: true };
    },
  });

  cased = route({
    method: "POST",
    path: "/cased",
    handler: (ctx) => {
      ctx.out.cookies.set("Session", "upper");
      ctx.out.cookies.set("session", "lower");

      return { ok: true };
    },
  });

  logout = route({
    method: "POST",
    path: "/logout",
    handler: (ctx) => {
      ctx.out.cookies.delete("session", { path: "/" });

      return { ok: true };
    },
  });

  fails = route({
    method: "POST",
    path: "/fails",
    handler: (ctx) => {
      ctx.out.cookies.delete("session");

      throw new HttpError(403);
    },
  });
}

const request = serve(createApp({ routes: new CookieController() }));

describe("the cookies slot", () => {
  test("types and validates what the request carried", async () => {
    const res = await request("/me", {
      headers: { cookie: "session=abc; theme=dark" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: "abc", theme: "dark" });
  });

  test("a declared cookie the request lacks is an ordinary 422", async () => {
    const res = await request("/me");

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "VALIDATION_FAILED",
      issues: [
        { message: "session is required", path: ["cookies", "session"] },
      ],
    });
  });

  test("a route that declares none has no cookies field at all", async () => {
    const res = await request("/bare", {
      headers: { cookie: "session=abc" },
    });

    // Lazy like `query` and `headers`: nothing is parsed for a route that
    // did not ask, and the absence is in the type as well as the runtime.
    expect(await res.json()).toEqual({ present: false });
  });

  test("what a hook put there is what gets validated, not the header", async () => {
    const res = await request("/normalized", {
      headers: { cookie: "session=from-the-wire" },
    });

    // The documented rule for every part: the input of validation is the
    // context, so a hook that supplies cookies replaces the header rather
    // than being overridden by it. Materializing stays lazy — the header
    // is never parsed on this route.
    expect(await res.json()).toEqual({ session: "from-hook" });
  });

  test("a __proto__ cookie becomes an own property, not a prototype", async () => {
    const res = await request("/polluted", {
      headers: { cookie: "session=abc; __proto__=sent-by-the-client" },
    });

    // On a plain `{}` this name hits the `Object.prototype` setter, which
    // ignores a string — the value would be dropped without a word. With
    // no prototype every name is an own data property, so what the client
    // sent is what the schema sees.
    expect(await res.json()).toEqual({
      own: true,
      value: "sent-by-the-client",
      prototypeMoved: false,
    });
  });
});

describe("writing them", () => {
  test("one call is one set-cookie, with its attributes", async () => {
    const res = await request("/login", { method: "POST" });

    expect(res.headers.getSetCookie()).toEqual([
      "session=user-42; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
      "theme=dark; Path=/; SameSite=Lax",
    ]);
  });

  test("writing the same name twice replaces rather than repeats", async () => {
    const res = await request("/rewritten", { method: "POST" });

    // A browser would take the last of two, so emitting both changes
    // nothing the client sees — it only sends a header the server did not
    // mean to send. `set` means set.
    expect(res.headers.getSetCookie()).toEqual([
      "theme=dark; Path=/; SameSite=Lax",
      "session=second; Path=/; SameSite=Lax",
    ]);
  });

  test("deleting a name drops what was staged under it", async () => {
    const res = await request("/staged", { method: "POST" });

    expect(res.headers.getSetCookie()).toEqual([
      "session=; Path=/; Max-Age=0; SameSite=Lax",
    ]);
  });

  test("names differing only in case are two cookies, because they are", async () => {
    const res = await request("/cased", { method: "POST" });

    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  test("delete expires it where it was set", async () => {
    const res = await request("/logout", { method: "POST" });

    expect(res.headers.getSetCookie()).toEqual([
      "session=; Path=/; Max-Age=0; SameSite=Lax",
    ]);
  });

  test("they survive an error response, like every other ctx.out write", async () => {
    const res = await request("/fails", { method: "POST" });

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });
});

describe("signing", () => {
  const sealed = serve(
    createApp({
      cookies: { secret: "top-secret", sign: ["session"] },
      routes: new CookieController(),
    }),
  );

  /** The value of one `set-cookie`, as the client would send it back. */
  function issued(header: string): string {
    return header.split(";")[0] ?? "";
  }

  test("a covered cookie leaves sealed and comes back opened", async () => {
    const login = await sealed("/login", { method: "POST" });
    const cookie = issued(login.headers.getSetCookie()[0] ?? "");

    expect(cookie).toMatch(/^session=user-42\..+/);

    const back = await sealed("/me", { headers: { cookie } });

    expect(await back.json()).toMatchObject({ session: "user-42" });
  });

  test("an uncovered cookie is neither sealed nor opened", async () => {
    const login = await sealed("/login", { method: "POST" });

    expect(issued(login.headers.getSetCookie()[1] ?? "")).toBe("theme=dark");

    const back = await sealed("/me", {
      headers: { cookie: "session=user-42.x; theme=dark" },
    });

    // `theme` passes through untouched; `session` fails its seal and is
    // gone, which the schema reports as missing.
    expect(back.status).toBe(422);
  });

  test("a tampered value reads as absent rather than as itself", async () => {
    const login = await sealed("/login", { method: "POST" });
    const cookie = issued(login.headers.getSetCookie()[0] ?? "");

    const forged = cookie.replace("user-42", "user-1");

    const back = await sealed("/me", { headers: { cookie: forged } });

    expect(back.status).toBe(422);
  });

  test("a value with dots of its own survives the round trip", async () => {
    const jwtish = serve(
      createApp({
        cookies: { secret: "top-secret" },
        routes: {
          issue: route({
            method: "POST",
            path: "/issue",
            handler: (ctx) => {
              ctx.out.cookies.set("session", "aaa.bbb.ccc");

              return { ok: true };
            },
          }),
          read: route({
            method: "GET",
            path: "/read",
            schema: { cookies: Session },
            handler: (ctx) => ({ session: ctx.cookies.session }),
          }),
        },
      }),
    );

    const issue = await jwtish("/issue", { method: "POST" });
    const cookie = issued(issue.headers.getSetCookie()[0] ?? "");

    const back = await jwtish("/read", { headers: { cookie } });

    // The signature is split off at the last dot, so a value made of
    // dot-separated fields comes back whole.
    expect(await back.json()).toEqual({ session: "aaa.bbb.ccc" });
  });

  test("an empty value survives the round trip", async () => {
    const blank = serve(
      createApp({
        cookies: { secret: "top-secret" },
        routes: {
          issue: route({
            method: "POST",
            path: "/issue",
            handler: (ctx) => {
              ctx.out.cookies.set("flag", "");

              return { ok: true };
            },
          }),
          read: route({
            method: "GET",
            path: "/read",
            schema: { cookies: AsIs },
            handler: (ctx) => ({ cookies: ctx.cookies }),
          }),
        },
      }),
    );

    const issue = await blank("/issue", { method: "POST" });
    const cookie = issued(issue.headers.getSetCookie()[0] ?? "");

    const back = await blank("/read", { headers: { cookie } });

    // Sealed, "" is nothing but a dot and the signature: the dot is the
    // first character, and the seal still holds.
    expect(await back.json()).toEqual({ cookies: { flag: "" } });
  });

  test("no secret means nothing is signed", async () => {
    const login = await request("/login", { method: "POST" });

    expect(issued(login.headers.getSetCookie()[0] ?? "")).toBe(
      "session=user-42",
    );
  });
});
