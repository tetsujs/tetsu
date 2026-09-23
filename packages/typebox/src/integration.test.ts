/**
 * Integration test: `tb()` schemas inside a real served application.
 *
 * The unit tests cover the adapter in isolation; this file proves the
 * dual-natured schema works end to end — parsing, coercion, stripping and
 * issue paths — when the core pipeline drives it over a live socket.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { Type } from "typebox";
import { file, files, tb } from "./index.ts";

const UserParams = tb(Type.Object({ id: Type.Number() }), { convert: true });

const CreateUser = tb(
  Type.Object({
    name: Type.String({ minLength: 1 }),
  }),
);

class UsersController {
  update = route({
    method: "POST",
    path: "/users/:id",
    schema: { params: UserParams, body: CreateUser },
    handler: (ctx) => ({ id: ctx.params.id, name: ctx.body.name }),
  });
}

const request = serve(createApp({ routes: new UsersController() }));

const PublicUser = tb(
  Type.Object({ id: Type.String(), email: Type.String() }),
  { clean: true },
);

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
}

const store = new Map<string, StoredUser>([
  ["u1", { id: "u1", email: "ada@example.com", passwordHash: "SECRET" }],
]);

class StoreController {
  read = route({
    method: "GET",
    path: "/stored/:id",
    schema: { response: PublicUser },
    handler: (ctx) => store.get(ctx.params.id) as StoredUser,
  });
}

const requestStore = serve(createApp({ routes: new StoreController() }));

describe("tb() through a served app", () => {
  test("coerces params and validates the body end to end", async () => {
    const res = await request("/users/7", {
      method: "POST",
      body: JSON.stringify({ name: "Ada" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 7, name: "Ada" });
  });

  test("rejects an invalid body with part-prefixed issue paths", async () => {
    const res = await request("/users/7", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });

    const body = (await res.json()) as {
      issues: { path: (string | number)[] }[];
    };

    expect(res.status).toBe(422);
    expect(body.issues[0]?.path).toEqual(["body", "name"]);
  });

  test("rejects uncoercible params", async () => {
    const res = await request("/users/abc", {
      method: "POST",
      body: JSON.stringify({ name: "Ada" }),
    });

    expect(res.status).toBe(422);
  });
});

describe("a clean response schema", () => {
  test("strips the response without mutating the handler's own object", async () => {
    const res = await requestStore("/stored/u1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "u1", email: "ada@example.com" });
    expect(store.get("u1")).toEqual({
      id: "u1",
      email: "ada@example.com",
      passwordHash: "SECRET",
    });
  });

  test("still strips on every later request", async () => {
    const first = await requestStore("/stored/u1");
    const second = await requestStore("/stored/u1");

    expect(await first.json()).toEqual(await second.json());
    expect(store.get("u1")?.passwordHash).toBe("SECRET");
  });
});

const Upload = tb(
  Type.Object({
    title: Type.String({ minLength: 1 }),
    avatar: file({ maxSize: "1k", type: "image" }),
    gallery: files({ maxSize: "1k" }),
  }),
);

class UploadController {
  create = route({
    method: "POST",
    path: "/uploads",
    bodyType: "form",
    schema: { body: Upload },
    handler: (ctx) => ({
      title: ctx.body.title,
      avatar: ctx.body.avatar.name,
      gallery: ctx.body.gallery.map((entry) => entry.name),
    }),
  });
}

const uploadRequest = serve(createApp({ routes: new UploadController() }));

const png = (name: string, size = 4) =>
  new File(["x".repeat(size)], name, { type: "image/png" });

const upload = (fill: (form: FormData) => void) => {
  const form = new FormData();

  form.append("title", "hello");
  fill(form);

  return uploadRequest("/uploads", { method: "POST", body: form });
};

describe("file schemas through a served app", () => {
  test("validates fields, a file and a list of files at once", async () => {
    const res = await upload((form) => {
      form.append("avatar", png("a.png"));
      form.append("gallery", png("g1.png"));
      form.append("gallery", png("g2.png"));
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "hello",
      avatar: "a.png",
      gallery: ["g1.png", "g2.png"],
    });
  });

  test("a lone file reaches the handler as a one-element array", async () => {
    const res = await upload((form) => {
      form.append("avatar", png("a.png"));
      form.append("gallery", png("only.png"));
    });

    expect(await res.json()).toMatchObject({ gallery: ["only.png"] });
  });

  test("rejects a file of the wrong type with its field path", async () => {
    const res = await upload((form) => {
      form.append("avatar", new File(["x"], "a.txt", { type: "text/plain" }));
      form.append("gallery", png("g1.png"));
    });

    const body = (await res.json()) as {
      issues: { message: string; path: (string | number)[] }[];
    };

    expect(res.status).toBe(422);
    expect(body.issues[0]).toEqual({
      message: "file type must be image",
      path: ["body", "avatar"],
    });
  });

  test("rejects an oversized file", async () => {
    const res = await upload((form) => {
      form.append("avatar", png("big.png", 2048));
      form.append("gallery", png("g1.png"));
    });

    const body = (await res.json()) as { issues: { message: string }[] };

    expect(res.status).toBe(422);
    expect(body.issues[0]?.message).toBe("file must be at most 1024 bytes");
  });

  test("rejects a missing file", async () => {
    const res = await upload((form) => {
      form.append("gallery", png("g1.png"));
    });

    expect(res.status).toBe(422);
  });
});

describe("what defaults mean for the description", () => {
  const Query = tb(
    Type.Object({
      limit: Type.Integer({ default: 20 }),
      page: Type.Integer(),
    }),
    { convert: true, defaults: true },
  );

  const target = { target: "openapi-3.1" } as const;

  class SearchController {
    search = route({
      method: "GET",
      path: "/search",
      schema: { query: Query },
      handler: (ctx) => ({ limit: ctx.query.limit, page: ctx.query.page }),
    });
  }

  const request = serve(createApp({ routes: new SearchController() }));

  test("a filled-in property is not required of the client", () => {
    const input = Query["~standard"].jsonSchema.input(target) as {
      required: string[];
    };

    expect(input.required).toEqual(["page"]);
    expect(
      (input as unknown as { properties: { limit: { default: number } } })
        .properties.limit.default,
    ).toBe(20);
  });

  test("on the way out it is required, because it is there", () => {
    const output = Query["~standard"].jsonSchema.output(target) as {
      required: string[];
    };

    expect(output.required.toSorted()).toEqual(["limit", "page"]);
  });

  test("and the server answers without it, as the description now says", async () => {
    const res = await request("/search?page=1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 20, page: 1 });
  });

  test("without defaults the property stays required in both directions", () => {
    const Strict = tb(Type.Object({ limit: Type.Integer({ default: 20 }) }), {
      convert: true,
    });

    expect(
      (Strict["~standard"].jsonSchema.input(target) as { required: string[] })
        .required,
    ).toEqual(["limit"]);
  });

  test("a nested default is dropped too, and the schema is not touched", () => {
    const raw = Type.Object({
      page: Type.Object({ size: Type.Integer({ default: 10 }) }),
    });

    const Nested = tb(raw, { defaults: true });

    const input = Nested["~standard"].jsonSchema.input(target) as {
      properties: { page: { required?: string[] } };
    };

    expect(input.properties.page.required).toBeUndefined();
    expect(raw.properties.page.required).toEqual(["size"]);
  });
});
