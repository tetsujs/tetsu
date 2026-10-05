/**
 * Tests for the hand-built context: its cookie options, and the server
 * it stands in for.
 *
 * @module
 */

import { expect, test } from "bun:test";
import { signedCookie } from "../src/wire.ts";
import { testCtx } from "./ctx.ts";

const cookies = { secret: "test-secret", sign: ["session"] } as const;

test("with the application's cookie options, a set cookie leaves signed", () => {
  const ctx = testCtx({}, { cookies });

  ctx.out.cookies.set("session", "u1");

  expect(ctx.out.headers.get("set-cookie")).toMatch(/^session=u1\.[^;]+/);
});

test("and signedCookie opens the one the request carries", () => {
  const issued = testCtx({}, { cookies });

  issued.out.cookies.set("session", "u1");

  const cookie = (issued.out.headers.get("set-cookie") ?? "").split(";")[0];
  const ctx = testCtx(
    { req: new Request("http://test/", { headers: { cookie: cookie ?? "" } }) },
    { cookies },
  );

  expect(signedCookie(ctx, "session")).toBe("u1");
});

test("without them, signedCookie says what is missing", () => {
  expect(() => signedCookie(testCtx({}), "session")).toThrow(
    "testCtx(parts, { cookies })",
  );
});

test("a timeout set on the server does nothing: there is no connection", () => {
  const ctx = testCtx({});

  expect(() => ctx.server.timeout(ctx.req, 30)).not.toThrow();
});

test("anything else on the server throws, so the test says what it needs", () => {
  const ctx = testCtx({});

  expect(() => ctx.server.requestIP(ctx.req)).toThrow("serve the app");
});
