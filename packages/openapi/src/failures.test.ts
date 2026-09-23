/**
 * The documented failures, checked against the responses the framework
 * actually produces.
 *
 * The generator writes the status, the code and an example message of
 * every failure it fills in — three literals that live in this package and
 * describe behaviour that lives in the core. Nothing but a test keeps them
 * from drifting apart, so each case here triggers the real failure over a
 * live server and holds the response up against its own documentation.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { OpenApiDocument } from "./document.ts";
import { documented, openapi } from "./index.ts";

/** Accepts any string, including the empty one. */
const AnyText: StandardSchemaV1<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value }
        : { issues: [{ message: "must be text", path: [] }] },
  },
};

/** Accepts an object with a `name`, rejects everything else. */
const Named: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as { name?: unknown })?.name === "string"
        ? { value: value as { name: string } }
        : { issues: [{ message: "name must be a string", path: ["name"] }] },
  },
};

class Controller {
  create = route({
    method: "POST",
    path: "/items",
    schema: { body: Named },
    handler: () => ({ ok: true }),
  });

  upload = route({
    method: "POST",
    path: "/uploads",
    bodyType: "form",
    schema: { body: Named },
    handler: () => ({ ok: true }),
  });

  note = route({
    method: "POST",
    path: "/notes",
    bodyType: "text",
    handler: () => ({ ok: true }),
  });

  ping = route({
    method: "POST",
    path: "/pings",
    bodyType: "json",
    handler: () => ({ ok: true }),
  });

  submit = route({
    method: "POST",
    path: "/forms",
    bodyType: "form",
    handler: () => ({ ok: true }),
  });

  label = route({
    method: "POST",
    path: "/labels",
    bodyType: "text",
    schema: { body: AnyText },
    handler: () => ({ ok: true }),
  });

  stream = route({
    method: "POST",
    path: "/streams",
    bodyType: "stream",
    handler: () => ({ ok: true }),
  });

  broken = route({
    method: "GET",
    path: "/broken",
    handler: () => {
      throw new Error("nothing mapped this");
    },
  });
}

const app = createApp({ routes: new Controller(), maxBodySize: 64 });
const request = serve(app);

const { document } = openapi(app, {
  info: { title: "Failures", version: "1.0.0" },
});

interface FailureSchema {
  properties: {
    status: { const: number };
    error: { const?: string };
    message: { examples?: string[] };
  };
}

/** Follows a `$ref` into `components/schemas`. */
const resolve = (schema: unknown): FailureSchema => {
  const ref = (schema as { $ref?: string }).$ref;

  if (!ref) {
    return schema as FailureSchema;
  }

  const schemas = document.components?.schemas as Record<string, FailureSchema>;

  return schemas[ref.replace("#/components/schemas/", "")] as FailureSchema;
};

/** The schema the document promises for one operation and status. */
const promised = (
  path: string,
  method: string,
  status: number,
): FailureSchema =>
  resolve(
    (document as OpenApiDocument).paths[path]?.[method]?.responses[
      String(status)
    ]?.content?.["application/json"]?.schema,
  );

/**
 * Asserts that a response is exactly what its documentation promised: the
 * status twice over, the code as a `const`, the message as the example.
 */
const matchesDocumentation = async (
  res: Response,
  path: string,
  method: string,
): Promise<void> => {
  const body = (await res.json()) as {
    status: number;
    message: string;
    error: string;
  };

  const schema = promised(path, method, res.status);

  expect(schema).toBeDefined();
  expect(body.status).toBe(res.status);
  expect(schema.properties.status.const).toBe(res.status);
  expect(schema.properties.error.const).toBe(body.error);
  expect(schema.properties.message.examples).toEqual([body.message]);
};

describe("what the document promises is what arrives", () => {
  test("a body that is not JSON", async () => {
    const res = await request("/items", { method: "POST", body: "{" });

    expect(res.status).toBe(400);
    await matchesDocumentation(res, "/items", "post");
  });

  test("a body that is not a form", async () => {
    const res = await request("/uploads", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=nope" },
      body: "not a form",
    });

    expect(res.status).toBe(400);
    await matchesDocumentation(res, "/uploads", "post");
  });

  test("a body over the limit", async () => {
    const res = await request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(128) }),
    });

    expect(res.status).toBe(413);
    await matchesDocumentation(res, "/items", "post");
  });

  test("a body the schema rejects", async () => {
    const res = await request("/items", {
      method: "POST",
      body: JSON.stringify({ name: 42 }),
    });

    expect(res.status).toBe(422);

    const body = (await res.clone().json()) as { error: string };
    const schema = promised("/items", "post", 422);

    expect(schema.properties.error.const).toBe(body.error);
    await matchesDocumentation(res, "/items", "post");
  });

  describe("a handler that throws", () => {
    let errors: { mockRestore: () => void } | undefined;

    beforeEach(() => {
      errors = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errors?.mockRestore();
    });

    test("is the documented 500", async () => {
      const res = await request("/broken");

      expect(res.status).toBe(500);
      await matchesDocumentation(res, "/broken", "get");
    });
  });
});

describe("what cannot happen is not documented", () => {
  test("a text body has no parse failure, only a size one", () => {
    const responses = document.paths["/notes"]?.post?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual(["200", "413", "500"]);
  });

  test("a stream body has no parse failure either, only a size one", () => {
    const responses = document.paths["/streams"]?.post?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual(["200", "413", "500"]);
  });

  test("every operation can answer 500", () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        expect(
          `${method} ${path}: ${operation.responses["500"] ? "yes" : "no"}`,
        ).toBe(`${method} ${path}: yes`);
      }
    }
  });
});

describe("the definitions the failures share", () => {
  test("every failure is a reference, defined once for the document", () => {
    const schemas = document.components?.schemas ?? {};

    expect(Object.keys(schemas).toSorted()).toEqual([
      "BodyTooLarge",
      "InternalServerError",
      "MalformedForm",
      "MalformedJson",
      "ValidationFailed",
    ]);
  });

  test("the same failure on two operations points at one definition", () => {
    const items = document.paths["/items"]?.post?.responses["500"]?.content?.[
      "application/json"
    ]?.schema as { $ref: string };

    const broken = document.paths["/broken"]?.get?.responses["500"]?.content?.[
      "application/json"
    ]?.schema as { $ref: string };

    expect(items.$ref).toBe("#/components/schemas/InternalServerError");
    expect(broken.$ref).toBe(items.$ref);
  });

  test("a code the framework does not know is named after its status", () => {
    const guarded = createApp({
      routes: {
        read: route({
          method: "GET",
          path: "/guarded",
          hooks: {
            beforeParse: [
              documented(
                hook.beforeParse(() => undefined),
                { responses: [{ status: 402, description: "Pay first" }] },
              ),
            ],
          },
          handler: () => ({}),
        }),
      },
    });

    const { document: withGuard } = openapi(guarded, {
      info: { title: "Guarded", version: "1.0.0" },
    });

    const schemas = withGuard.components?.schemas ?? {};

    expect(Object.keys(schemas)).toContain("Failure402");
  });

  test("a code that survives no sanitising is named after its status too", () => {
    /** A hook declaring a failure under `code`. */
    const guard = (status: number, code: string) =>
      documented(
        hook.beforeParse(() => undefined),
        { responses: [{ status, description: "Refused", error: code }] },
      );

    const named = createApp({
      routes: {
        cyrillic: route({
          method: "GET",
          path: "/cyrillic",
          hooks: { beforeParse: [guard(451, "ОШИБКА")] },
          handler: () => ({}),
        }),
        symbols: route({
          method: "GET",
          path: "/symbols",
          hooks: { beforeParse: [guard(452, "!!!")] },
          handler: () => ({}),
        }),
        japanese: route({
          method: "GET",
          path: "/japanese",
          hooks: { beforeParse: [guard(453, "認証エラー")] },
          handler: () => ({}),
        }),
      },
    });

    const { document: withNames } = openapi(named, {
      info: { title: "Named", version: "1.0.0" },
    });

    const keys = Object.keys(withNames.components?.schemas ?? {});

    expect(keys).toContain("Failure451");
    expect(keys).toContain("Failure452");
    expect(keys).toContain("Failure453");
    // The shapes that used to appear: an empty key, and "2" from the
    // collision numbering that an empty preferred name walked into.
    expect(keys).not.toContain("");
    expect(keys).not.toContain("2");

    const ref = withNames.paths["/cyrillic"]?.get?.responses["451"]?.content?.[
      "application/json"
    ]?.schema as { $ref: string };

    expect(ref.$ref).toBe("#/components/schemas/Failure451");
  });
});

describe("a schema on any one part documents the validation failure", () => {
  // One route per member of the condition, each carrying a schema on that
  // slot and nothing else. A route carrying two of them keeps the condition
  // true with either one removed, which is how three of the four went
  // unpinned while looking covered.
  class PartsController {
    byParams = route({
      method: "POST",
      path: "/params/:id",
      schema: { params: Named },
      handler: () => ({ ok: true }),
    });

    byQuery = route({
      method: "POST",
      path: "/query",
      schema: { query: Named },
      handler: () => ({ ok: true }),
    });

    byHeaders = route({
      method: "POST",
      path: "/headers",
      schema: { headers: Named },
      handler: () => ({ ok: true }),
    });

    byBody = route({
      method: "POST",
      path: "/body",
      schema: { body: Named },
      handler: () => ({ ok: true }),
    });

    byNothing = route({
      method: "POST",
      path: "/nothing",
      handler: () => ({ ok: true }),
    });
  }

  const { document: parts } = openapi(
    createApp({ routes: new PartsController() }),
    { info: { title: "Parts", version: "1.0.0" } },
  );

  const statuses = (path: string) =>
    Object.keys(parts.paths[path]?.post?.responses ?? {});

  test("params alone", () => {
    expect(statuses("/params/{id}")).toContain("422");
  });

  test("query alone", () => {
    expect(statuses("/query")).toContain("422");
  });

  test("headers alone", () => {
    expect(statuses("/headers")).toContain("422");
  });

  test("body alone", () => {
    expect(statuses("/body")).toContain("422");
  });

  test("and a route with no schema at all does not claim it", () => {
    expect(statuses("/nothing")).not.toContain("422");
  });
});

describe("whether a body is required", () => {
  /** What the document says, and what the server does with no body at all. */
  const bodyless = async (path: string) => {
    const res = await request(path, { method: "POST" });

    return {
      documented: document.paths[path]?.post?.requestBody?.required,
      status: res.status,
      body: await res.text(),
    };
  };

  test("json says required, with a schema and without one", async () => {
    const declared = await bodyless("/items");
    const bare = await bodyless("/pings");

    expect(declared.documented).toBe(true);
    expect(declared.status).toBe(400);
    expect(bare.documented).toBe(true);
    expect(bare.status).toBe(400);
    expect(bare.body).toContain("MALFORMED_JSON");
  });

  test("form says required, with a schema and without one", async () => {
    const declared = await bodyless("/uploads");
    const bare = await bodyless("/forms");

    expect(declared.documented).toBe(true);
    expect(declared.status).toBe(400);
    expect(bare.documented).toBe(true);
    expect(bare.status).toBe(400);
    expect(bare.body).toContain("MALFORMED_FORM");
  });

  test("text says optional, because an absent body reads as empty", async () => {
    const bare = await bodyless("/notes");
    const declared = await bodyless("/labels");

    expect(bare.documented).toBe(false);
    expect(bare.status).toBe(200);
    expect(declared.documented).toBe(false);
    expect(declared.status).toBe(200);
  });

  test("stream says optional, because an absent body reads as an empty stream", async () => {
    const bare = await bodyless("/streams");

    expect(bare.documented).toBe(false);
    expect(bare.status).toBe(200);
  });
});
