/**
 * Integration tests: request body shapes through a live server.
 *
 * `bodyType` declares how the bytes are parsed — form (multipart and
 * urlencoded alike), text, or JSON. Files arrive as native `File` values
 * inside `ctx.body` and pass through the route's schema like any other
 * field, so a validator that can describe a file describes it there.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

const filePart = (value: unknown): value is File => value instanceof File;

const Upload: StandardSchemaV1<unknown, { title: string; avatar: File }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const body = value as { title?: unknown; avatar?: unknown };

      if (typeof body.title !== "string") {
        return { issues: [{ message: "title is required", path: ["title"] }] };
      }

      if (!filePart(body.avatar)) {
        return {
          issues: [{ message: "avatar must be a file", path: ["avatar"] }],
        };
      }

      if (body.avatar.size > 8) {
        return {
          issues: [{ message: "avatar is too large", path: ["avatar"] }],
        };
      }

      return { value: { title: body.title, avatar: body.avatar } };
    },
  },
};

class BodyController {
  form = route({
    method: "POST",
    path: "/form",
    bodyType: "form",
    handler: (ctx) => ({
      keys: Object.keys(ctx.body),
      title: ctx.body.title ?? null,
      tag: ctx.body.tag ?? null,
      avatarIsFile: filePart(ctx.body.avatar),
      prototype: String(Object.getPrototypeOf(ctx.body)),
    }),
  });

  validated = route({
    method: "POST",
    path: "/avatars",
    bodyType: "form",
    schema: { body: Upload },
    handler: async (ctx) => ({
      title: ctx.body.title,
      name: ctx.body.avatar.name,
      type: ctx.body.avatar.type,
      size: ctx.body.avatar.size,
      content: await ctx.body.avatar.text(),
    }),
  });

  text = route({
    method: "POST",
    path: "/text",
    bodyType: "text",
    handler: (ctx) => ({
      length: ctx.body.length,
      upper: ctx.body.toUpperCase(),
    }),
  });

  json = route({
    method: "POST",
    path: "/json",
    bodyType: "json",
    handler: (ctx) => ({ got: ctx.body }),
  });

  undeclared = route({
    method: "POST",
    path: "/undeclared",
    handler: (ctx) => ({ read: "body" in (ctx as object) }),
  });

  /** The documented way past the limit: read the stream yourself. */
  hatch = route({
    method: "POST",
    path: "/hatch",
    handler: async (ctx) => {
      let seen = 0;

      if (ctx.req.body) {
        for await (const chunk of ctx.req.body) {
          seen += (chunk as Uint8Array).byteLength;
        }
      }

      return { seen };
    },
  });
}

const request = serve(createApp({ routes: new BodyController() }));

const multipart = () => {
  const form = new FormData();

  form.append("title", "hello");
  form.append("tag", "a");
  form.append("tag", "b");
  form.append("avatar", new File(["PNGDATA"], "a.png", { type: "image/png" }));

  return form;
};

describe("a form body", () => {
  test("parses multipart fields, files and repeated names", async () => {
    const res = await request("/form", { method: "POST", body: multipart() });

    expect(await res.json()).toEqual({
      keys: ["title", "tag", "avatar"],
      title: "hello",
      tag: ["a", "b"],
      avatarIsFile: true,
      prototype: "null",
    });
  });

  test("parses urlencoded through the same declaration", async () => {
    const body = new URLSearchParams([
      ["title", "hello"],
      ["tag", "a"],
      ["tag", "b"],
    ]);

    const res = await request("/form", { method: "POST", body });

    expect(await res.json()).toMatchObject({
      title: "hello",
      tag: ["a", "b"],
      avatarIsFile: false,
    });
  });

  test("keeps a field named like a prototype key as data", async () => {
    const body = new URLSearchParams([
      ["__proto__", "evil"],
      ["a", "1"],
    ]);

    const res = await request("/form", { method: "POST", body });

    expect(await res.json()).toMatchObject({
      keys: ["__proto__", "a"],
      prototype: "null",
    });
  });

  test("a body that is not a form is a 400, not a reinterpretation", async () => {
    const res = await request("/form", {
      method: "POST",
      body: JSON.stringify({ title: "hello" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 400,
      message: "Body is not a valid form",
      error: "MALFORMED_FORM",
    });
  });
});

describe("a form body through a schema", () => {
  test("validates fields and files together", async () => {
    const res = await request("/avatars", {
      method: "POST",
      body: multipart(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "hello",
      name: "a.png",
      type: "image/png",
      size: 7,
      content: "PNGDATA",
    });
  });

  test("rejects a file the schema refuses", async () => {
    const form = new FormData();

    form.append("title", "hello");
    form.append("avatar", new File(["x".repeat(64)], "big.png"));

    const res = await request("/avatars", { method: "POST", body: form });

    const body = (await res.json()) as {
      issues: { path: (string | number)[] }[];
    };

    expect(res.status).toBe(422);
    expect(body.issues[0]?.path).toEqual(["body", "avatar"]);
  });

  test("rejects a missing file with the field's path", async () => {
    const form = new FormData();

    form.append("title", "hello");

    const res = await request("/avatars", { method: "POST", body: form });

    const body = (await res.json()) as {
      issues: { message: string }[];
    };

    expect(res.status).toBe(422);
    expect(body.issues[0]?.message).toBe("avatar must be a file");
  });
});

describe("a text body", () => {
  test("arrives as the raw string", async () => {
    const res = await request("/text", { method: "POST", body: "hi there" });

    expect(await res.json()).toEqual({ length: 8, upper: "HI THERE" });
  });

  test("is not parsed as JSON even when it looks like it", async () => {
    const res = await request("/text", { method: "POST", body: '{"a":1}' });

    expect(await res.json()).toEqual({ length: 7, upper: '{"A":1}' });
  });
});

describe("a json body", () => {
  test("keeps parsing as before", async () => {
    const res = await request("/json", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });

    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  test("a form posted to it is a 400", async () => {
    const res = await request("/json", { method: "POST", body: multipart() });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      status: 400,
      message: "Body is not valid JSON",
      error: "MALFORMED_JSON",
    });
  });
});

describe("reading the body at all", () => {
  test("a declared bodyType reads it without any schema", async () => {
    const res = await request("/text", { method: "POST", body: "read me" });

    expect(await res.json()).toMatchObject({ length: 7 });
  });

  test("neither a schema nor a bodyType leaves the body untouched", async () => {
    const res = await request("/undeclared", {
      method: "POST",
      body: "never read",
    });

    expect(await res.json()).toEqual({ read: false });
  });
});

describe("the size limit covers every shape", () => {
  const limited = serve(
    createApp({ routes: new BodyController(), maxBodySize: 1024 }),
  );

  test("an oversized form is a 413", async () => {
    const form = new FormData();

    form.append("avatar", new File(["x".repeat(4096)], "big.bin"));

    const res = await limited("/form", { method: "POST", body: form });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });
  });

  test("an oversized text body is a 413", async () => {
    const res = await limited("/text", {
      method: "POST",
      body: "x".repeat(4096),
    });

    expect(res.status).toBe(413);
  });

  test("the limit counts multipart framing, not just the payload", async () => {
    const wire = await new Response(multipart()).arrayBuffer();

    expect(wire.byteLength).toBeGreaterThan(500);

    const tight = serve(
      createApp({ routes: new BodyController(), maxBodySize: 128 }),
    );

    const res = await tight("/form", { method: "POST", body: multipart() });

    expect(res.status).toBe(413);
  });

  test("a form within the limit passes", async () => {
    const res = await limited("/form", { method: "POST", body: multipart() });

    expect(res.status).toBe(200);
  });
});

describe("the shape the limit does not cover", () => {
  const limited = serve(
    createApp({ routes: new BodyController(), maxBodySize: 1024 }),
  );

  test("a handler reading the stream itself is not held to maxBodySize", async () => {
    // `maxBodySize` is enforced while the pipeline reads the body, and a
    // route that declares nothing never asks it to. So the documented way
    // to take a large upload is also a way past the limit the application
    // configured — deliberately, because the bytes are the handler's from
    // that point on, and nobody else can count them.
    //
    // Pinned rather than merely written down: this is the kind of thing a
    // later change makes quietly untrue.
    const res = await limited("/hatch", {
      method: "POST",
      body: "x".repeat(64 * 1024),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: 64 * 1024 });
  });

  test("the same bytes through a declared body are a 413", async () => {
    const res = await limited("/text", {
      method: "POST",
      body: "x".repeat(64 * 1024),
    });

    expect(res.status).toBe(413);
  });
});
