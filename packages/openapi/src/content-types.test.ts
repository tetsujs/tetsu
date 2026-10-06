/**
 * Tests for bodies that are not JSON, and for handlers that say what they
 * answer with.
 *
 * A status of a route's response map can name the media type of its body,
 * and a handler annotated with `documented()` contributes responses of its
 * own — a package's handler describes the route it is mounted on without
 * a line from the route's author. It can also keep that route out of the
 * document until the route asks for it.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { App, BaseCtx, StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { OpenApiDocument, ResponseObject } from "./document.ts";
import { documented, openapi, secured } from "./index.ts";

const described = <T>(jsonSchema: Record<string, unknown>) =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1<unknown, T>;

const Lines = described<string>({
  type: "string",
  description: "One order per line",
});

const Order = described<{ id: number }>({
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
});

const generate = (app: App): OpenApiDocument =>
  openapi(app, { info: { title: "Content", version: "1" } }).document;

const responsesOf = (
  document: OpenApiDocument,
  path: string,
): Record<string, ResponseObject> => document.paths[path]?.get?.responses ?? {};

const etag = { schema: { type: "string" } } as const;

const file = (ctx: BaseCtx) =>
  new Response(`file at ${new URL(ctx.req.url).pathname}`, {
    headers: { "content-type": "text/plain", etag: '"1"' },
  });

const files = documented(file, {
  responses: [
    {
      status: 200,
      description: "The file",
      contentType: "*/*",
      headers: { etag },
    },
    { status: 304, description: "Not modified", headers: { etag } },
    { status: 404, description: "No such file", error: "NOT_FOUND" },
    {
      status: 404,
      description: "The site's own page",
      contentType: "text/html",
    },
  ],
});

describe("a status whose body is not JSON", () => {
  const document = generate(
    createApp({
      routes: {
        lines: route({
          method: "GET",
          path: "/orders.csv",
          schema: {
            response: { 200: { contentType: "text/csv", body: Lines } },
          },
          handler: () => new Response("7\n8"),
        }),
        invoice: route({
          method: "GET",
          path: "/invoice",
          schema: { response: { 200: { contentType: "application/pdf" } } },
          handler: () => new Response(new Uint8Array([37, 80, 68, 70])),
        }),
        anything: route({
          method: "GET",
          path: "/anything",
          schema: { response: { 200: { contentType: "*/*" } } },
          handler: () => new Response("?"),
        }),
        stated: route({
          method: "GET",
          path: "/stated",
          schema: {
            response: { 200: { contentType: "application/json", body: Order } },
          },
          handler: () => ({ id: 1 }),
        }),
        implied: route({
          method: "GET",
          path: "/implied",
          schema: { response: { 200: Order } },
          handler: () => ({ id: 1 }),
        }),
      },
    }),
  );

  test("is described under its own media type, schema and all", () => {
    const ok = responsesOf(document, "/orders.csv")["200"];

    expect(ok?.description).toBe("One order per line");
    expect(Object.keys(ok?.content ?? {})).toEqual(["text/csv"]);
    expect(ok?.content?.["text/csv"]?.schema).toMatchObject({
      type: "string",
    });
  });

  test("without a schema, is described by its type alone", () => {
    expect(responsesOf(document, "/invoice")["200"]).toEqual({
      description: "Successful response",
      content: { "application/pdf": {} },
    });
  });

  test("a range stands for a body of any type", () => {
    expect(responsesOf(document, "/anything")["200"]?.content).toEqual({
      "*/*": {},
    });
  });

  test("application/json is what a status without a content type already is", () => {
    expect(responsesOf(document, "/stated")["200"]).toEqual(
      responsesOf(document, "/implied")["200"],
    );
  });

  test("leaves the framework's own failures JSON beside it", () => {
    expect(
      Object.keys(responsesOf(document, "/orders.csv")["500"]?.content ?? {}),
    ).toEqual(["application/json"]);
  });
});

describe("a handler that says what it answers with", () => {
  const document = generate(
    createApp({
      routes: {
        files: route({ method: "GET", path: "/files/*", handler: files }),
        bare: route({ method: "GET", path: "/bare/*", handler: file }),
      },
    }),
  );

  const answers = responsesOf(document, "/files/{wildcard}");

  test("answers for its route, which needs no placeholder", () => {
    expect(answers["200"]).toEqual({
      description: "The file",
      headers: { etag },
      content: { "*/*": {} },
    });
  });

  test("a status without a body has none in the document", () => {
    expect(answers["304"]).toEqual({
      description: "Not modified",
      headers: { etag },
    });
  });

  test("two bodies of one status are both described, each under its type", () => {
    const missing = answers["404"];

    expect(Object.keys(missing?.content ?? {})).toEqual([
      "application/json",
      "text/html",
    ]);
    expect(missing?.content?.["application/json"]?.schema).toHaveProperty(
      "$ref",
    );
    expect(missing?.content?.["text/html"]).toEqual({});
    expect(missing?.description).toBe(
      "- `NOT_FOUND`: No such file\n- The site's own page",
    );
  });

  test("the function it was made from carries nothing", () => {
    expect(responsesOf(document, "/bare/{wildcard}")["200"]).toEqual({
      description: "Successful response",
    });
  });

  test("still answers as the function it was made from", async () => {
    const request = serve(
      createApp({
        routes: {
          files: route({ method: "GET", path: "/files/*", handler: files }),
        },
      }),
    );

    const res = await request("/files/a.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file at /files/a.txt");

    request.stop();
  });

  test("a second annotation keeps what the first one said", () => {
    const twice = documented(files, { hidden: false });

    expect(
      responsesOf(
        generate(
          createApp({
            routes: {
              twice: route({ method: "GET", path: "/twice/*", handler: twice }),
            },
          }),
        ),
        "/twice/{wildcard}",
      )["304"]?.description,
    ).toBe("Not modified");
  });
});

describe("a handler that keeps its route out of the document", () => {
  const hidden = documented(files, { hidden: true });

  const document = generate(
    createApp({
      routes: {
        assets: route({ method: "GET", path: "/assets/*", handler: hidden }),
        downloads: route({
          method: "GET",
          path: "/downloads/*",
          docs: { hidden: false },
          handler: hidden,
        }),
        internal: route({
          method: "GET",
          path: "/internal/*",
          docs: { hidden: true },
          handler: files,
        }),
      },
    }),
  );

  test("hides the route that says nothing", () => {
    expect(document.paths["/assets/{wildcard}"]).toBeUndefined();
  });

  test("shows the route that asks for it, described", () => {
    expect(
      responsesOf(document, "/downloads/{wildcard}")["200"]?.description,
    ).toBe("The file");
  });

  test("a route that hides itself is hidden whatever its handler says", () => {
    expect(document.paths["/internal/{wildcard}"]).toBeUndefined();
  });
});

describe("what a hook says about a response", () => {
  const location = { schema: { type: "string" } } as const;

  const signIn = documented(
    hook.beforeParse(() => undefined),
    {
      responses: [
        {
          status: 302,
          description: "Sent to sign in",
          headers: { location },
        },
        {
          status: 429,
          description: "Too many requests",
          error: "RATE_LIMITED",
        },
        {
          status: 406,
          description: "Only HTML here",
          contentType: "text/html",
        },
      ],
    },
  );

  const answers = responsesOf(
    generate(
      createApp({
        routes: {
          page: route({
            method: "GET",
            path: "/page",
            hooks: { beforeParse: [signIn] },
            handler: () => ({ ok: true }),
          }),
        },
      }),
    ),
    "/page",
  );

  test("a status below 400 without a schema has no body", () => {
    expect(answers["302"]).toEqual({
      description: "Sent to sign in",
      headers: { location },
    });
  });

  test("an error status without a schema is the envelope, as it was", () => {
    expect(Object.keys(answers["429"]?.content ?? {})).toEqual([
      "application/json",
    ]);
  });

  test("a hook names a media type the same way a handler does", () => {
    expect(answers["406"]?.content).toEqual({ "text/html": {} });
  });
});

describe("a content type given to documented()", () => {
  test.each([
    ["parameters", "text/html; charset=utf-8"],
    ["nothing", ""],
    ["no subtype", "html"],
  ])("is refused with %s, where it is annotated", (_, contentType) => {
    expect(() =>
      documented(file, {
        responses: [{ status: 200, description: "The page", contentType }],
      }),
    ).toThrow(
      `The 200 response given to documented() has the content type ${JSON.stringify(contentType)}`,
    );
  });

  test("is taken in any case", () => {
    expect(() =>
      documented(file, {
        responses: [
          { status: 200, description: "The page", contentType: "TEXT/HTML" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("a security refusal below 400", () => {
  const signIn = secured(
    hook.beforeParse(() => undefined),
    {
      name: "session",
      scheme: { type: "apiKey", in: "cookie", name: "session" },
      status: 302,
      description: "Sent to sign in",
    },
  );

  test("has no body, as any documented response below 400", () => {
    const answers = responsesOf(
      generate(
        createApp({
          routes: {
            page: route({
              method: "GET",
              path: "/page",
              hooks: { beforeParse: [signIn] },
              handler: () => ({ ok: true }),
            }),
          },
        }),
      ),
      "/page",
    );

    expect(answers["302"]).toEqual({ description: "Sent to sign in" });
  });
});

describe("an envelope a handler documents", () => {
  const MissingFile = described<object>({
    type: "object",
    required: ["status", "message", "error", "path"],
    properties: {
      status: { type: "number", const: 404 },
      message: { type: "string" },
      error: { type: "string", const: "NOT_FOUND" },
      path: { type: "string" },
    },
  });

  const lookup = documented(file, {
    responses: [
      { status: 404, description: "No such file", schema: MissingFile },
    ],
  });

  const missing = documented(
    hook.beforeParse(() => undefined),
    { responses: [{ status: 404, description: "Gone", error: "NOT_FOUND" }] },
  );

  const handled = route({ method: "GET", path: "/files/*", handler: lookup });
  const guarded = route({
    method: "GET",
    path: "/guarded",
    hooks: { beforeParse: [missing] },
    handler: () => ({ ok: true }),
  });

  test.each([
    ["the handler's route first", { handled, guarded }],
    ["the hook's route first", { guarded, handled }],
  ])("is the definition the document keeps, %s", (_, routes) => {
    const document = generate(createApp({ routes }));
    const schemas = (document.components?.schemas ?? {}) as Record<
      string,
      { properties?: Record<string, { const?: unknown }> }
    >;
    const notFound = Object.values(schemas).filter(
      (schema) => schema.properties?.error?.const === "NOT_FOUND",
    );

    expect(
      notFound.map((schema) => Object.keys(schema.properties ?? {})),
    ).toEqual([["status", "message", "error", "path"]]);
  });
});

describe("one media type said twice", () => {
  const page = documented(file, {
    responses: [
      { status: 200, description: "The page", contentType: "text/html" },
    ],
  });

  const answers = (contentType: string, body?: StandardSchemaV1) =>
    responsesOf(
      generate(
        createApp({
          routes: {
            page: route({
              method: "GET",
              path: "/page",
              schema: {
                response: {
                  200: body ? { contentType, body } : { contentType },
                },
              },
              handler: page,
            }),
          },
        }),
      ),
      "/page",
    )["200"];

  test("is one key, in lower case", () => {
    expect(Object.keys(answers("Text/HTML")?.content ?? {})).toEqual([
      "text/html",
    ]);
  });

  test("takes any body when one of its answers has no schema", () => {
    expect(answers("text/html", Lines)?.content).toEqual({ "text/html": {} });
  });
});
