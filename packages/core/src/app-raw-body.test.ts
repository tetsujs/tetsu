/**
 * Integration tests: the raw bytes of a body next to the body parsed.
 *
 * A webhook is signed over the bytes it was sent as, and handled as the
 * payload those bytes carry. `rawBody: true` gives a route both: the
 * bytes in `ctx.rawBody`, the payload parsed and validated in `ctx.body`,
 * and a `beforeValidation` hook between the two to check the signature
 * before anything is validated.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { httpError } from "./error.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

const Event: StandardSchemaV1<unknown, { type: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as { type?: unknown })?.type === "string"
        ? { value: { type: (value as { type: string }).type } }
        : { issues: [{ message: "type is required" }] },
  },
};

/** A stand-in for an HMAC: the signature is the byte count. */
const signed = hook.beforeValidation(
  (ctx: Requires<{ rawBody: Uint8Array }>) => {
    if (ctx.req.headers.get("x-signature") !== String(ctx.rawBody.byteLength)) {
      throw httpError(401, "BAD_SIGNATURE");
    }
  },
);

const forger = hook.beforeValidation(() => ({
  rawBody: new Uint8Array([1, 2, 3]),
}));

const app = createApp({
  routes: {
    webhook: route({
      method: "POST",
      path: "/webhook",
      rawBody: true,
      schema: { body: Event },
      hooks: { beforeValidation: [signed] },
      handler: (ctx) => ({
        type: ctx.body.type,
        bytes: [...ctx.rawBody],
      }),
    }),
    text: route({
      method: "POST",
      path: "/text",
      rawBody: true,
      bodyType: "text",
      handler: (ctx) => ({ text: ctx.body, bytes: ctx.rawBody.byteLength }),
    }),
    forged: route({
      method: "POST",
      path: "/forged",
      rawBody: true,
      hooks: { beforeValidation: [forger] },
      handler: (ctx) => ({ bytes: ctx.rawBody.byteLength }),
    }),
    small: route({
      method: "POST",
      path: "/small",
      rawBody: true,
      maxBodySize: 8,
      handler: () => ({ read: true }),
    }),
    plain: route({
      method: "POST",
      path: "/plain",
      schema: { body: Event },
      handler: (ctx) => ({ raw: "rawBody" in ctx }),
    }),
  },
});

const request = serve(app);

const post = (
  path: string,
  body: string,
  headers: Record<string, string> = {},
) => request(path, { method: "POST", body, headers });

describe("a route that asks for the raw body", () => {
  const payload = '{"type":"paid","note":"é"}';
  const bytes = [...new TextEncoder().encode(payload)];

  test("gets the bytes it was sent and the body parsed from them", async () => {
    const res = await post("/webhook", payload, {
      "x-signature": String(bytes.length),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "paid", bytes });
  });

  test("lets a hook refuse on the bytes before the body is validated", async () => {
    const res = await post("/webhook", '{"no":"type"}', {
      "x-signature": "0",
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "BAD_SIGNATURE",
    );
  });

  test("works for a text body as well", async () => {
    const res = await post("/text", "héllo");

    expect(await res.json()).toEqual({ text: "héllo", bytes: 6 });
  });

  test("is not something a hook can replace", async () => {
    const res = await post("/forged", '{"a":1}');

    expect(await res.json()).toEqual({ bytes: 7 });
  });

  test("keeps to the body limit", async () => {
    const res = await post("/small", '{"too":"long"}');

    expect(res.status).toBe(413);
  });
});

describe("a route that does not ask", () => {
  test("has no raw body", async () => {
    const res = await post("/plain", '{"type":"paid"}');

    expect(await res.json()).toEqual({ raw: false });
  });
});

describe("a raw body that cannot be", () => {
  test("is refused next to a form or a stream, at startup", () => {
    for (const bodyType of ["form", "stream"]) {
      expect(() =>
        route({
          method: "POST",
          path: "/x",
          rawBody: true,
          bodyType,
          handler: () => ({}),
        } as never),
      ).toThrow(/rawBody/);
    }
  });
});
