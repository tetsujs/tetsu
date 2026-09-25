/**
 * Tests for the document generator.
 *
 * Schemas here are written against the Standard JSON Schema interface
 * directly rather than through a validator package: what the generator
 * consumes is that interface, and testing it through TypeBox would test
 * TypeBox.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { AnyHook, RouteDef, StandardSchemaV1 } from "@tetsujs/core";
import { controller, createApp, group, hook, route, ws } from "@tetsujs/core";
import { docsOf, securityOf } from "./annotations.ts";
import type { OpenApiDocument } from "./document.ts";
import { docs, docsPage, documented, openapi, secured } from "./index.ts";

/** A schema that both validates and describes itself. */
const described = <T>(
  jsonSchema: Record<string, unknown>,
): StandardSchemaV1<unknown, T> =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1<unknown, T>;

/** A schema that validates but cannot describe itself. */
const opaque = <T>(): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as T }),
  },
});

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });

const info = { title: "Test API", version: "1.0.0" };

const generate = (app: Parameters<typeof openapi>[0]) => openapi(app, { info });

/**
 * Follows a `$ref` into `components/schemas`.
 *
 * The framework's own failure envelopes are defined once per document and
 * referenced from the operations, so a test that wants to read one has to
 * dereference it first.
 */
const deref = (
  document: OpenApiDocument,
  schema: unknown,
): Record<string, never> => {
  const ref = (schema as { $ref?: string })?.$ref;

  if (!ref) {
    return schema as Record<string, never>;
  }

  const schemas = document.components?.schemas as Record<string, never>;

  return schemas[ref.replace("#/components/schemas/", "")] as unknown as Record<
    string,
    never
  >;
};

describe("the document", () => {
  test("declares 3.1 and carries the caller's metadata", () => {
    const { document } = openapi(createApp({ routes: [] }), {
      info: { title: "Test API", version: "2.0.0", description: "Everything" },
      servers: [{ url: "https://api.example.com" }],
    });

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({
      title: "Test API",
      version: "2.0.0",
      description: "Everything",
    });
    expect(document.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(document.paths).toEqual({});
  });

  test("merges the methods of one path into one item", () => {
    class UsersController {
      list = route({ method: "GET", path: "/users", handler: () => [] });
      create = route({ method: "POST", path: "/users", handler: () => ({}) });
    }

    const { document } = generate(createApp({ routes: new UsersController() }));

    expect(Object.keys(document.paths)).toEqual(["/users"]);
    expect(Object.keys(document.paths["/users"] ?? {}).toSorted()).toEqual([
      "get",
      "post",
    ]);
  });
});

describe("path templates", () => {
  test("rewrites parameters and declares them", () => {
    class OrdersController {
      item = route({
        method: "GET",
        path: "/orders/:orderId/items/:itemId",
        handler: () => ({}),
      });
    }

    const { document } = generate(
      createApp({ routes: new OrdersController() }),
    );
    const operation = document.paths["/orders/{orderId}/items/{itemId}"]?.get;

    expect(operation?.parameters).toEqual([
      {
        name: "orderId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "itemId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  test("documents a wildcard as a named segment", () => {
    class FilesController {
      serve = route({ method: "GET", path: "/files/*", handler: () => ({}) });
    }

    const { document } = generate(createApp({ routes: new FilesController() }));
    const operation = document.paths["/files/{wildcard}"]?.get;

    expect(operation?.parameters?.[0]).toMatchObject({
      name: "wildcard",
      in: "path",
      required: true,
    });
    expect(operation?.parameters?.[0]?.description).toContain(
      "rest of the path",
    );
  });

  test("takes a parameter's shape from the params schema", () => {
    class OrdersController {
      get = route({
        method: "GET",
        path: "/orders/:id",
        schema: {
          params: described<{ id: number }>(
            object({ id: { type: "integer" } }, ["id"]),
          ),
        },
        handler: () => ({}),
      });
    }

    const { document } = generate(
      createApp({ routes: new OrdersController() }),
    );

    expect(document.paths["/orders/{id}"]?.get?.parameters?.[0]).toEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "integer" },
    });
  });
});

describe("query and header parameters", () => {
  class SearchController {
    search = route({
      method: "GET",
      path: "/search",
      schema: {
        query: described<{ q: string; page?: number }>(
          object({ q: { type: "string" }, page: { type: "integer" } }, ["q"]),
        ),
        headers: described<{ "x-tenant": string }>(
          object({ "x-tenant": { type: "string" } }, ["x-tenant"]),
        ),
      },
      handler: () => ({}),
    });
  }

  const { document } = generate(createApp({ routes: new SearchController() }));
  const parameters = document.paths["/search"]?.get?.parameters ?? [];

  test("lists one parameter per declared property", () => {
    expect(
      parameters.map((parameter) => `${parameter.in}:${parameter.name}`),
    ).toEqual(["query:q", "query:page", "header:x-tenant"]);
  });

  test("marks the optional ones optional", () => {
    expect(parameters.map((parameter) => parameter.required)).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe("request bodies", () => {
  const Fields = described<{ title: string }>(
    object({ title: { type: "string" } }, ["title"]),
  );

  const WithFile = described<{ avatar: File }>(
    object({
      avatar: { type: "string", contentEncoding: "binary" },
    }),
  );

  class BodyController {
    json = route({
      method: "POST",
      path: "/json",
      schema: { body: Fields },
      handler: () => ({}),
    });

    text = route({
      method: "POST",
      path: "/text",
      bodyType: "text",
      handler: () => ({}),
    });

    form = route({
      method: "POST",
      path: "/form",
      bodyType: "form",
      schema: { body: Fields },
      handler: () => ({}),
    });

    upload = route({
      method: "POST",
      path: "/upload",
      bodyType: "form",
      schema: { body: WithFile },
      handler: () => ({}),
    });

    none = route({ method: "POST", path: "/none", handler: () => ({}) });
  }

  const { document } = generate(createApp({ routes: new BodyController() }));

  const contentOf = (path: string) =>
    Object.keys(document.paths[path]?.post?.requestBody?.content ?? {});

  test("a json body is application/json", () => {
    expect(contentOf("/json")).toEqual(["application/json"]);
  });

  test("a text body is text/plain", () => {
    expect(contentOf("/text")).toEqual(["text/plain"]);
  });

  test("a form body lists both encodings it accepts", () => {
    expect(contentOf("/form")).toEqual([
      "multipart/form-data",
      "application/x-www-form-urlencoded",
    ]);
  });

  test("a form carrying a file is multipart only", () => {
    expect(contentOf("/upload")).toEqual(["multipart/form-data"]);
  });

  test("a route that reads no body declares none", () => {
    expect(document.paths["/none"]?.post?.requestBody).toBeUndefined();
  });

  test("the declared schema is the body's schema", () => {
    expect(
      document.paths["/json"]?.post?.requestBody?.content["application/json"]
        ?.schema,
    ).toEqual(object({ title: { type: "string" } }, ["title"]));
  });
});

describe("responses", () => {
  const User = described<{ id: number }>(object({ id: { type: "integer" } }));
  const NotFound = described<{ code: string }>(
    object({ code: { type: "string" } }),
  );

  class ResponseController {
    single = route({
      method: "GET",
      path: "/single",
      schema: { response: User },
      handler: () => ({ id: 1 }),
    });

    mapped = route({
      method: "GET",
      path: "/mapped",
      schema: { response: { 200: User, 201: User, 404: NotFound } },
      handler: () => ({ id: 1 }),
    });

    validated = route({
      method: "POST",
      path: "/validated",
      schema: { body: User, response: User },
      handler: () => ({ id: 1 }),
    });

    bare = route({ method: "GET", path: "/bare", handler: () => ({}) });
  }

  const { document } = generate(
    createApp({ routes: new ResponseController() }),
  );

  const statusesOf = (path: string, method = "get") =>
    Object.keys(document.paths[path]?.[method]?.responses ?? {}).toSorted();

  test("a single schema documents the 200", () => {
    expect(statusesOf("/single")).toEqual(["200", "500"]);
    expect(
      document.paths["/single"]?.get?.responses["200"]?.content?.[
        "application/json"
      ]?.schema,
    ).toEqual(object({ id: { type: "integer" } }));
  });

  test("a status declared as null is documented without a body", () => {
    class EmptyController {
      remove = route({
        method: "DELETE",
        path: "/sessions",
        schema: { response: { 204: null } },
        handler: () => undefined,
      });
    }

    const { document: emptied } = generate(
      createApp({ routes: new EmptyController() }),
    );

    const responses = emptied.paths["/sessions"]?.delete?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual(["204", "500"]);
    expect(responses["204"]).toEqual({ description: "No content" });
  });

  test("a map documents every status it declares", () => {
    expect(statusesOf("/mapped")).toEqual(["200", "201", "404", "500"]);
  });

  test("a route without a response schema still answers something", () => {
    expect(statusesOf("/bare")).toEqual(["200", "500"]);
    expect(
      document.paths["/bare"]?.get?.responses["200"]?.content,
    ).toBeUndefined();
  });

  test("the framework's own failures are filled in", () => {
    expect(statusesOf("/validated", "post")).toEqual([
      "200",
      "400",
      "413",
      "422",
      "500",
    ]);
  });

  test("the validation status is the one configured", () => {
    const strict = createApp({
      routes: new ResponseController(),
      validation: { status: 400 },
    });

    const { document: strictDocument } = generate(strict);
    const responses = strictDocument.paths["/validated"]?.post?.responses;

    expect(Object.keys(responses ?? {}).toSorted()).toEqual([
      "200",
      "400",
      "413",
      "500",
    ]);
  });

  test("failures sharing a status are documented as alternatives", () => {
    const strict = createApp({
      routes: new ResponseController(),
      validation: { status: 400 },
    });

    const { document: strictDocument } = generate(strict);
    const collided = strictDocument.paths["/validated"]?.post?.responses["400"];

    expect(collided?.description).toBe(
      "Request failed schema validation; Body could not be parsed in the declared shape",
    );

    const schema = collided?.content?.["application/json"]?.schema as {
      anyOf: unknown[];
    };

    const codes = schema.anyOf.map(
      (member) =>
        (
          deref(strictDocument, member) as unknown as {
            properties: { error: { const?: string } };
          }
        ).properties.error.const,
    );

    expect(codes).toEqual(["VALIDATION_FAILED", "MALFORMED_JSON"]);
  });

  test("a declared response the generator could not describe still merges", () => {
    class OpaqueController {
      own = route({
        method: "POST",
        path: "/opaque",
        schema: { body: User, response: { 200: User, 400: opaque<unknown>() } },
        handler: () => ({ id: 1 }),
      });
    }

    const { document: opaqueDocument } = generate(
      createApp({ routes: new OpaqueController() }),
    );

    const own = opaqueDocument.paths["/opaque"]?.post?.responses["400"];

    expect(own?.description).toBe(
      "Response 400; Body could not be parsed in the declared shape",
    );

    expect(own?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/MalformedJson",
    });
  });

  test("two failures with the same body are one alternative", () => {
    const first = documented(
      hook.beforeParse(() => undefined),
      { responses: [{ status: 409, description: "Already claimed" }] },
    );

    const second = documented(
      hook.beforeParse(() => undefined),
      { responses: [{ status: 409, description: "Already shipped" }] },
    );

    const { document: conflicts } = generate(
      createApp({
        hooks: { beforeParse: [first, second] },
        routes: {
          act: route({ method: "POST", path: "/act", handler: () => ({}) }),
        },
      }),
    );

    const response = conflicts.paths["/act"]?.post?.responses["409"];

    expect(response?.description).toBe("Already claimed; Already shipped");
    expect(response?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/Failure409",
    });
  });

  test("a declared status is joined by the ones filled in, never replaced", () => {
    class OwnController {
      own = route({
        method: "POST",
        path: "/own",
        schema: { body: User, response: { 200: User, 422: NotFound } },
        handler: () => ({ id: 1 }),
      });
    }

    const { document: ownDocument } = generate(
      createApp({ routes: new OwnController() }),
    );

    const own = ownDocument.paths["/own"]?.post?.responses["422"];
    const schema = own?.content?.["application/json"]?.schema as {
      anyOf: unknown[];
    };

    expect(own?.description).toBe(
      "Response 422; Request failed schema validation",
    );

    expect(schema.anyOf[0]).toEqual(object({ code: { type: "string" } }));
    expect(deref(ownDocument, schema.anyOf[1])).toMatchObject({
      properties: { error: { const: "VALIDATION_FAILED" } },
    });
  });
});

describe("operation identity and documentation", () => {
  class UsersController {
    setAvatar = route({
      method: "POST",
      path: "/users/:id/avatar",
      docs: {
        summary: "Upload an avatar",
        description: "Replaces the current one",
        tags: ["users", "media"],
        deprecated: true,
      },
      handler: () => ({}),
    });
  }

  const standalone = route({
    method: "GET",
    path: "/health/live",
    handler: () => ({}),
  });

  const { document } = generate(
    createApp({ routes: [new UsersController(), standalone] }),
  );

  test("names an operation after its controller field", () => {
    expect(document.paths["/users/{id}/avatar"]?.post?.operationId).toBe(
      "usersSetAvatar",
    );
  });

  test("falls back to method and path without a field", () => {
    expect(document.paths["/health/live"]?.get?.operationId).toBe(
      "getHealthLive",
    );
  });

  test("carries the route's documentation through", () => {
    expect(document.paths["/users/{id}/avatar"]?.post).toMatchObject({
      summary: "Upload an avatar",
      description: "Replaces the current one",
      tags: ["users", "media"],
      deprecated: true,
    });
  });
});

describe("schemas that cannot describe themselves", () => {
  class OpaqueController {
    create = route({
      method: "POST",
      path: "/opaque/:id",
      schema: {
        params: opaque<{ id: string }>(),
        query: opaque<{ page: number }>(),
        body: opaque<{ title: string }>(),
        response: opaque<{ id: string }>(),
      },
      handler: () => ({ id: "1" }),
    });
  }

  const { document, warnings } = generate(
    createApp({ routes: new OpaqueController() }),
  );

  test("names every part it could not describe", () => {
    expect(warnings.map((warning) => warning.message)).toEqual([
      "the params schema does not emit JSON Schema",
      "the query schema does not emit JSON Schema",
      "the body schema does not emit JSON Schema",
      "a response schema does not emit JSON Schema",
    ]);
    expect(warnings[0]?.route).toBe("POST /opaque/:id");
  });

  test("still documents the operation, without the shapes", () => {
    const operation = document.paths["/opaque/{id}"]?.post;

    expect(operation?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(operation?.requestBody?.content["application/json"]).toEqual({});
    expect(operation?.responses["200"]?.content).toBeUndefined();
  });

  test("a fully described route warns about nothing", () => {
    class CleanController {
      get = route({
        method: "GET",
        path: "/clean",
        schema: { response: described<{ id: number }>(object({})) },
        handler: () => ({ id: 1 }),
      });
    }

    expect(
      generate(createApp({ routes: new CleanController() })).warnings,
    ).toEqual([]);
  });
});

describe("structural invariants", () => {
  class MixedController {
    item = route({
      method: "GET",
      path: "/orders/:orderId/items/:itemId",
      schema: {
        params: described<{ orderId: string; itemId: string }>(
          object({ orderId: { type: "string" } }),
        ),
      },
      handler: () => ({}),
    });

    files = route({ method: "GET", path: "/files/*", handler: () => ({}) });

    upload = route({
      method: "POST",
      path: "/orders/:orderId/attachments",
      bodyType: "form",
      handler: () => ({}),
    });
  }

  const { document } = generate(createApp({ routes: new MixedController() }));

  test("every template variable has a declared parameter", () => {
    for (const [template, item] of Object.entries(document.paths)) {
      const variables = [...template.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1] ?? "",
      );

      for (const operation of Object.values(item)) {
        const declaredNames = (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name);

        expect(declaredNames.toSorted()).toEqual(variables.toSorted());
      }
    }
  });

  test("every path parameter is required, as the spec demands", () => {
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        for (const parameter of operation.parameters ?? []) {
          if (parameter.in === "path") {
            expect(parameter.required).toBe(true);
          }
        }
      }
    }
  });

  test("every response carries a description", () => {
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        for (const response of Object.values(operation.responses)) {
          expect(response.description.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("every operation id is unique", () => {
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a hook that accepts either of two credentials", () => {
  const cookie = {
    name: "session",
    scheme: { type: "apiKey", in: "cookie", name: "session" },
  } as const;
  const bearer = {
    name: "bearer",
    scheme: { type: "http", scheme: "bearer" },
  } as const;
  const csrf = {
    name: "csrf",
    scheme: { type: "apiKey", in: "header", name: "x-csrf-token" },
    status: 403,
  } as const;

  const caller = () =>
    secured(
      hook.beforeParse(() => ({ user: { id: "u1" } })),
      {
        anyOf: [cookie, bearer],
      },
    );
  const csrfCheck = secured(
    hook.beforeParse(() => undefined),
    csrf,
  );

  const securityAt = (
    hooks: Record<string, readonly AnyHook[]>,
    appHooks?: Record<string, readonly AnyHook[]>,
  ) => {
    const { document } = generate(
      createApp({
        ...(appHooks ? { hooks: appHooks as never } : {}),
        routes: {
          read: route({
            method: "GET",
            path: "/x",
            hooks: hooks as never,
            handler: () => ({}),
          }),
        },
      }),
    );

    return document;
  };

  test("alone, it is any one of its alternatives", () => {
    const document = securityAt({ beforeParse: [caller()] });

    expect(document.paths["/x"]?.get?.security).toEqual([
      { session: [] },
      { bearer: [] },
    ]);
  });

  test("next to another hook, it is each alternative together with it", () => {
    const document = securityAt({ beforeParse: [caller(), csrfCheck] });

    expect(document.paths["/x"]?.get?.security).toEqual([
      { session: [], csrf: [] },
      { bearer: [], csrf: [] },
    ]);
  });

  test("every scheme it mentions is registered, and every refusal answered", () => {
    const document = securityAt({ beforeParse: [caller(), csrfCheck] });

    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual([
      "session",
      "bearer",
      "csrf",
    ]);
    expect(Object.keys(document.paths["/x"]?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(["401", "403"]),
    );
  });

  test("the same guard on the application and the route is one condition", () => {
    const document = securityAt(
      { beforeParse: [caller()] },
      { beforeParse: [caller()] },
    );

    expect(document.paths["/x"]?.get?.security).toEqual([
      { session: [] },
      { bearer: [] },
    ]);
  });

  test("two hooks with alternatives give every pairing of them", () => {
    const signed = secured(
      hook.beforeParse(() => undefined),
      {
        anyOf: [
          {
            name: "hmac",
            scheme: { type: "apiKey", in: "header", name: "x-sig" },
          },
          { name: "mtls", scheme: { type: "mutualTLS" } },
        ],
      },
    );

    const document = securityAt({ beforeParse: [caller(), signed] });

    expect(document.paths["/x"]?.get?.security).toEqual([
      { session: [], hmac: [] },
      { session: [], mtls: [] },
      { bearer: [], hmac: [] },
      { bearer: [], mtls: [] },
    ]);
  });

  test("an alternative of a scheme another hook requires joins its scopes", () => {
    const oauth = { type: "oauth2", flows: {} } as const;
    const either = secured(
      hook.beforeParse(() => undefined),
      {
        anyOf: [
          { name: "oauth", scheme: oauth, scopes: ["notes:read"] },
          {
            name: "apiKey",
            scheme: { type: "apiKey", in: "header", name: "x-key" },
          },
        ],
      },
    );
    const writes = secured(
      hook.beforeParse(() => undefined),
      {
        name: "oauth",
        scheme: oauth,
        scopes: ["notes:write"],
      },
    );

    const document = securityAt({ beforeParse: [either, writes] });

    expect(document.paths["/x"]?.get?.security).toEqual([
      { oauth: ["notes:read", "notes:write"] },
      { apiKey: [], oauth: ["notes:write"] },
    ]);
  });
});

describe("security carried by hooks", () => {
  const bearer = {
    name: "bearerAuth",
    scheme: { type: "http", scheme: "bearer" },
  } as const;

  const auth = secured(
    hook.beforeParse(() => ({ user: { id: "u1" } })),
    bearer,
  );

  const apiKey = secured(
    hook.beforeParse(() => undefined),
    {
      name: "apiKey",
      scheme: { type: "apiKey", in: "header", name: "x-api-key" },
      status: 403,
      description: "Missing or unknown key",
    },
  );

  class SecuredController {
    read = route({
      method: "GET",
      path: "/secured",
      hooks: { beforeParse: [auth] },
      handler: () => ({}),
    });

    open = route({ method: "GET", path: "/open", handler: () => ({}) });
  }

  const { document } = generate(
    createApp({
      routes: new SecuredController(),
      hooks: { beforeParse: [apiKey] },
    }),
  );

  test("registers every scheme it saw", () => {
    expect(document.components?.securitySchemes).toEqual({
      apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      bearerAuth: { type: "http", scheme: "bearer" },
    });
  });

  test("requires every one a route runs, together, not any one of them", () => {
    // OpenAPI reads the entries of `security` as alternatives and the keys
    // of one entry as all required. Every hook of a chain runs, so every
    // scheme they carry is required at once: one entry.
    expect(document.paths["/secured"]?.get?.security).toEqual([
      { apiKey: [], bearerAuth: [] },
    ]);
  });

  test("two hooks of one scheme require the scopes of both", () => {
    const oauth = { type: "oauth2", flows: {} } as const;
    const reads = secured(
      hook.beforeParse(() => undefined),
      {
        name: "oauth",
        scheme: oauth,
        scopes: ["notes:read"],
      },
    );
    const writes = secured(
      hook.beforeParse(() => undefined),
      {
        name: "oauth",
        scheme: oauth,
        scopes: ["notes:write", "notes:read"],
      },
    );

    class NotesController {
      change = route({
        method: "PUT",
        path: "/notes",
        hooks: { beforeParse: [reads, writes] },
        handler: () => ({}),
      });
    }

    const { document: scoped } = generate(
      createApp({ routes: new NotesController() }),
    );

    expect(scoped.paths["/notes"]?.put?.security).toEqual([
      { oauth: ["notes:read", "notes:write"] },
    ]);
  });

  test("an application-wide guard secures every route", () => {
    expect(document.paths["/open"]?.get?.security).toEqual([{ apiKey: [] }]);
  });

  test("documents the refusal each scheme answers with", () => {
    const responses = document.paths["/secured"]?.get?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual([
      "200",
      "401",
      "403",
      "500",
    ]);
    expect(responses["401"]?.description).toBe(
      "Request did not satisfy bearerAuth",
    );
    expect(responses["403"]?.description).toBe("Missing or unknown key");
  });

  test("annotating leaves the original hook untouched", () => {
    const plain = hook.beforeParse(() => undefined);
    const annotated = secured(plain, bearer);

    expect(annotated).not.toBe(plain);
    expect(securityOf(plain)).toBeUndefined();
    expect(securityOf(annotated)).toEqual(bearer);
  });

  test("an unsecured application declares no schemes", () => {
    class OpenController {
      read = route({ method: "GET", path: "/open", handler: () => ({}) });
    }

    const { document: open } = generate(
      createApp({ routes: new OpenController() }),
    );

    expect(open.components?.securitySchemes).toBeUndefined();
  });
});

describe("the documentation page", () => {
  test("bootstraps scalar from its data attribute", () => {
    const page = docsPage({ ui: "scalar", documentUrl: "/openapi.json" });

    expect(page).toContain(
      '<script id="api-reference" data-url="/openapi.json">',
    );
    expect(page).toContain("@scalar/api-reference");
    expect(page).toContain("<title>API documentation</title>");
  });

  test("bootstraps swagger-ui with its stylesheet and call", () => {
    const page = docsPage({
      ui: "swagger-ui",
      documentUrl: "/openapi.json",
      title: "Users API",
    });

    expect(page).toContain("swagger-ui.css");
    expect(page).toContain('SwaggerUIBundle({ url: "/openapi.json"');
    expect(page).toContain("<title>Users API</title>");
  });

  test("bootstraps redoc from its element", () => {
    const page = docsPage({ ui: "redoc", documentUrl: "/openapi.json" });

    expect(page).toContain('<redoc spec-url="/openapi.json">');
  });

  test("loads from where it is told to", () => {
    const page = docsPage({
      ui: "scalar",
      documentUrl: "/openapi.json",
      assets: { script: "/vendor/scalar.js" },
    });

    expect(page).toContain('src="/vendor/scalar.js"');
    expect(page).not.toContain("jsdelivr");
  });

  test("escapes what it interpolates", () => {
    const page = docsPage({
      ui: "scalar",
      documentUrl: '/openapi.json" onload="alert(1)',
      title: "<script>alert(1)</script>",
    });

    expect(page).not.toContain('onload="alert(1)"');
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&quot;");
  });
});

describe("socket endpoints", () => {
  class MixedController {
    feed = ws({ path: "/feed", message: () => undefined });
    list = route({ method: "GET", path: "/items", handler: () => [] });
  }

  const { document, warnings } = generate(
    createApp({ routes: new MixedController() }),
  );

  test("are left out of the document", () => {
    expect(Object.keys(document.paths)).toEqual(["/items"]);
  });

  test("are not a gap worth warning about", () => {
    expect(warnings).toEqual([]);
  });
});

describe("routes hidden from the document", () => {
  const internal = secured(
    hook.beforeParse(() => undefined),
    {
      name: "adminKey",
      scheme: { type: "apiKey", in: "header", name: "x-key" },
    },
  );

  class MixedController {
    list = route({ method: "GET", path: "/items", handler: () => [] });

    drain = route({
      method: "POST",
      path: "/internal/drain",
      hooks: { beforeParse: [internal] },
      docs: { summary: "Drain the queue", hidden: true },
      handler: () => undefined,
    });

    create = route({
      method: "POST",
      path: "/items",
      docs: { hidden: true },
      handler: () => "ok",
    });
  }

  const { document } = generate(createApp({ routes: new MixedController() }));

  test("a hidden route is absent", () => {
    expect(Object.keys(document.paths)).toEqual(["/items"]);
  });

  test("a path keeps the methods that are not hidden", () => {
    expect(Object.keys(document.paths["/items"] ?? {})).toEqual(["get"]);
  });

  test("what a hidden route required is not registered either", () => {
    expect(document.components?.securitySchemes).toBeUndefined();
  });

  test("hiding says nothing about serving", () => {
    const paths = createApp({ routes: new MixedController() }).entries.map(
      (entry) => `${entry.method} ${entry.path}`,
    );

    expect(paths).toContain("POST /internal/drain");
  });
});

describe("responses contributed by hooks", () => {
  const TooMany = described<{ retryAfter: number }>(
    object({ retryAfter: { type: "integer" } }, ["retryAfter"]),
  );

  const limiter = documented(
    hook.beforeParse(() => undefined),
    {
      responses: [
        { status: 429, description: "Rate limit exceeded", schema: TooMany },
      ],
    },
  );

  const audited = documented(
    hook.afterResponse(() => undefined),
    {
      responses: [{ status: 503, description: "Audit sink unavailable" }],
    },
  );

  const challenged = documented(
    hook.beforeParse(() => undefined),
    {
      responses: [
        {
          status: 403,
          description: "Captcha required",
          error: "CAPTCHA_REQUIRED",
          fields: {
            siteKey: { type: "string" },
            error: { type: "integer" },
          },
          headers: {
            "x-captcha-site": {
              description: "Where the challenge is served",
              schema: { type: "string", format: "uri" },
            },
          },
        },
      ],
    },
  );

  class LimitedController {
    guarded = route({
      method: "GET",
      path: "/guarded",
      hooks: { beforeParse: [challenged] },
      handler: () => ({}),
    });

    read = route({
      method: "GET",
      path: "/limited",
      hooks: { beforeParse: [limiter], afterResponse: [audited] },
      handler: () => ({}),
    });

    own = route({
      method: "GET",
      path: "/own",
      schema: { response: { 200: TooMany, 429: TooMany } },
      hooks: { beforeParse: [limiter] },
      handler: () => ({ retryAfter: 1 }),
    });
  }

  const { document } = generate(createApp({ routes: new LimitedController() }));

  test("appear on every operation the hook runs on", () => {
    const responses = document.paths["/limited"]?.get?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual([
      "200",
      "429",
      "500",
      "503",
    ]);
    expect(responses["429"]?.description).toBe("Rate limit exceeded");
    expect(responses["429"]?.content?.["application/json"]?.schema).toEqual(
      object({ retryAfter: { type: "integer" } }, ["retryAfter"]),
    );
  });

  test("a hook without a schema still says what it answers", () => {
    const responses = document.paths["/limited"]?.get?.responses ?? {};

    expect(responses["503"]?.description).toBe("Audit sink unavailable");
    expect(
      deref(document, responses["503"]?.content?.["application/json"]?.schema),
    ).toMatchObject({ required: ["status", "message", "error"] });
  });

  test("fields the hook adds to the envelope are documented with it", () => {
    const responses = document.paths["/guarded"]?.get?.responses ?? {};
    const schema = responses["403"]?.content?.["application/json"]?.schema;

    expect(schema).toEqual({ $ref: "#/components/schemas/CaptchaRequired" });
    expect(deref(document, schema)).toMatchObject({
      required: ["status", "message", "error", "siteKey"],
      properties: { siteKey: { type: "string" } },
    });
  });

  test("headers the hook sets are documented on its response", () => {
    const responses = document.paths["/guarded"]?.get?.responses ?? {};

    expect(responses["403"]?.headers).toEqual({
      "x-captcha-site": {
        description: "Where the challenge is served",
        schema: { type: "string", format: "uri" },
      },
    });
    expect(responses["500"]?.headers).toBeUndefined();
  });

  test("an added field does not redefine the envelope's own", () => {
    const responses = document.paths["/guarded"]?.get?.responses ?? {};
    const schema = deref(
      document,
      responses["403"]?.content?.["application/json"]?.schema,
    );

    expect(schema).toMatchObject({
      properties: { error: { type: "string", const: "CAPTCHA_REQUIRED" } },
    });
  });

  test("what the route declared itself comes first", () => {
    const responses = document.paths["/own"]?.get?.responses ?? {};

    expect(responses["429"]?.description).toBe(
      "Response 429; Rate limit exceeded",
    );
  });

  test("secured is documented with a security requirement", () => {
    const auth = secured(
      hook.beforeParse(() => undefined),
      {
        name: "bearerAuth",
        scheme: { type: "http", scheme: "bearer" },
      },
    );

    expect(docsOf(auth)?.security).toMatchObject({ name: "bearerAuth" });
    expect(docsOf(auth)?.responses).toBeUndefined();
  });

  test("annotations accumulate rather than replace", () => {
    const both = documented(
      secured(
        hook.beforeParse(() => undefined),
        {
          name: "apiKey",
          scheme: { type: "apiKey", in: "header", name: "x-key" },
        },
      ),
      { responses: [{ status: 429, description: "Too many" }] },
    );

    expect(docsOf(both)?.security).toMatchObject({ name: "apiKey" });
    expect(docsOf(both)?.responses).toHaveLength(1);
  });
});

describe("operation ids", () => {
  const info = { title: "Ids", version: "1" };

  /** Collects the ids of a document, in document order. */
  const idsOf = (document: OpenApiDocument): string[] =>
    Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );

  const documentOf = (routes: object | readonly object[]) =>
    openapi(createApp({ routes }), { info }).document;

  const users = (): { list: RouteDef } => ({
    list: route({ method: "GET", path: "/", handler: () => [] }),
  });

  test("a named controller's route is the name and the field", () => {
    const usersController = controller("Users", users);

    expect(idsOf(documentOf(usersController()))).toEqual(["usersList"]);
  });

  test("a class is named by its constructor, without the Controller suffix", () => {
    class UsersController {
      list = route({ method: "GET", path: "/", handler: () => [] });
    }

    expect(idsOf(documentOf(new UsersController()))).toEqual(["usersList"]);
  });

  test("an unnamed object's route is its field", () => {
    expect(idsOf(documentOf(users()))).toEqual(["list"]);
  });

  test("a standalone route is its method and path", () => {
    const standalone = route({
      method: "POST",
      path: "/auth/code",
      handler: () => null,
    });

    expect(idsOf(documentOf(standalone))).toEqual(["postAuthCode"]);
  });

  test("an id stated on the route wins", () => {
    const merchants = controller("Merchants", () => ({
      list: route({
        method: "GET",
        path: "/",
        docs: { operationId: "listMerchants" },
        handler: () => [],
      }),
    }));

    expect(idsOf(documentOf(merchants()))).toEqual(["listMerchants"]);
  });

  test("two versions of one API are two controllers over one body", () => {
    const usersV1 = controller("UsersV1", users);
    const usersV2 = controller("UsersV2", users);

    const document = documentOf([
      group("/v1/users", { children: [usersV1()] }),
      group("/v2/users", { children: [usersV2()] }),
    ]);

    expect(idsOf(document)).toEqual(["usersV1List", "usersV2List"]);
  });

  test("two routes arriving at one id are refused, naming both", () => {
    const first = controller("First", () => ({
      list: route({
        method: "GET",
        path: "/first",
        docs: { operationId: "list" },
        handler: () => [],
      }),
    }));

    const second = controller("Second", () => ({
      list: route({
        method: "GET",
        path: "/second",
        docs: { operationId: "list" },
        handler: () => [],
      }),
    }));

    expect(() => documentOf([first(), second()])).toThrow(
      'operationId "list" is taken by both GET /first and GET /second',
    );
  });

  test("with docs() mounted, a collision stops the application at startup", () => {
    const first = controller("Users", users);
    const second = route({
      method: "GET",
      path: "/elsewhere",
      docs: { operationId: "usersList" },
      handler: () => [],
    });

    expect(() =>
      createApp({ routes: [first(), second, docs({ info })] }),
    ).toThrow('operationId "usersList" is taken by both');
  });

  test("a stated id meeting a derived one is refused too", () => {
    const usersController = controller("Users", users);

    const other = route({
      method: "GET",
      path: "/other",
      docs: { operationId: "usersList" },
      handler: () => [],
    });

    expect(() => documentOf([usersController(), other])).toThrow(
      'operationId "usersList" is taken by both',
    );
  });

  test("an unnamed object's field meeting another's is refused, not renamed", () => {
    expect(() =>
      documentOf([
        group("/a", { children: [users()] }),
        group("/b", { children: [users()] }),
      ]),
    ).toThrow('operationId "list" is taken by both GET /a and GET /b');
  });
});

describe("a schema that cannot be described", () => {
  const info = { title: "Hostile", version: "1" };

  /** A schema whose converter throws instead of answering. */
  const explodes = <T>(): StandardSchemaV1<unknown, T> =>
    ({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as T }),
        jsonSchema: {
          input: () => {
            throw new Error("converter gave up");
          },
          output: () => {
            throw new Error("converter gave up");
          },
        },
      },
    }) as unknown as StandardSchemaV1<unknown, T>;

  /** An emitted schema nested `levels` deep. */
  const deep = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { type: "string" };

    for (let level = 0; level < levels; level += 1) {
      node = { type: "object", properties: { nested: node } };
    }

    return node;
  };

  test("a converter that throws warns, wherever it is declared", () => {
    class HostileController {
      post = route({
        method: "POST",
        path: "/hostile/:id",
        schema: {
          params: explodes<{ id: string }>(),
          query: explodes<{ q: string }>(),
          body: explodes<{ name: string }>(),
          response: explodes<{ ok: boolean }>(),
        },
        handler: () => ({ ok: true }),
      });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new HostileController() }),
      { info },
    );

    expect(warnings.map((warning) => warning.message).toSorted()).toEqual([
      "a response schema failed to emit JSON Schema: converter gave up",
      "the body schema failed to emit JSON Schema: converter gave up",
      "the params schema failed to emit JSON Schema: converter gave up",
      "the query schema failed to emit JSON Schema: converter gave up",
    ]);
    expect(document.paths["/hostile/{id}"]?.post?.operationId).toBe(
      "hostilePost",
    );
  });

  test("a schema too deep to walk does not take the document with it", () => {
    class DeepController {
      upload = route({
        method: "POST",
        path: "/deep",
        bodyType: "form",
        schema: { body: described<{ nested: unknown }>(deep(30_000)) },
        handler: () => ({}),
      });
    }

    const { document } = openapi(createApp({ routes: new DeepController() }), {
      info,
    });

    expect(document.paths["/deep"]?.post?.requestBody).toBeDefined();
  });

  // In a child process on purpose: without the guard this does not fail,
  // it spins. A synchronous loop cannot be cut short by a test timeout, so
  // the regression would wedge the suite instead of reporting itself.
  test("a schema that refers back to itself does not hang", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import { createApp, route } from "${import.meta.dir}/../../core/src/index.ts";
          import { openapi } from "${import.meta.dir}/index.ts";

          const cyclic = { type: "object" };

          cyclic.properties = { self: cyclic };

          class CyclicController {
            upload = route({
              method: "POST",
              path: "/cyclic",
              bodyType: "form",
              schema: {
                body: {
                  "~standard": {
                    version: 1,
                    vendor: "test",
                    validate: (value) => ({ value }),
                    jsonSchema: { input: () => cyclic, output: () => cyclic },
                  },
                },
              },
              handler: () => ({}),
            });
          }

          const { document } = openapi(
            createApp({ routes: new CyclicController() }),
            { info: { title: "Cyclic", version: "1" } },
          );

          console.log(document.paths["/cyclic"] ? "described" : "missing");
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const finished = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);

    if (!finished) {
      child.kill();
    }

    const printed = await new Response(child.stdout).text();

    expect(finished).toBe(true);
    // Whatever the child complained about belongs in the failure message.
    expect(printed + (await new Response(child.stderr).text())).toContain(
      "described",
    );
  });
});

describe("two routes that share one path template", () => {
  const info = { title: "Collisions", version: "1" };

  test("a wildcard and a parameter named after it collide, with a warning", () => {
    class FilesController {
      byName = route({
        method: "GET",
        path: "/files/:wildcard",
        handler: () => "named",
      });

      byGlob = route({
        method: "GET",
        path: "/files/*",
        handler: () => "glob",
      });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new FilesController() }),
      { info },
    );

    expect(Object.keys(document.paths)).toEqual(["/files/{wildcard}"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("/files/{wildcard} is already");
    expect(warnings[0]?.route).toBe("GET /files/*");
  });

  test("the same template under different methods is not a collision", () => {
    class UsersController {
      get = route({ method: "GET", path: "/users/:id", handler: () => ({}) });
      put = route({ method: "PUT", path: "/users/:id", handler: () => ({}) });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new UsersController() }),
      { info },
    );

    expect(warnings).toEqual([]);
    expect(Object.keys(document.paths["/users/{id}"] ?? {}).toSorted()).toEqual(
      ["get", "put"],
    );
  });
});

describe("one security scheme name, two definitions", () => {
  const info = { title: "Schemes", version: "1" };

  const legacy = secured(
    hook.beforeParse(() => undefined),
    {
      name: "apiKey",
      scheme: { type: "apiKey", in: "header", name: "x-legacy-key" },
    },
  );

  const modern = secured(
    hook.beforeParse(() => undefined),
    {
      name: "apiKey",
      scheme: { type: "apiKey", in: "header", name: "x-modern-key" },
    },
  );

  test("across routes the first definition stands, and the clash is reported", () => {
    class ApiController {
      old = route({
        method: "GET",
        path: "/legacy",
        hooks: { beforeParse: [legacy] },
        handler: () => ({}),
      });

      recent = route({
        method: "GET",
        path: "/modern",
        hooks: { beforeParse: [modern] },
        handler: () => ({}),
      });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new ApiController() }),
      { info },
    );

    expect(document.components?.securitySchemes?.apiKey).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-legacy-key",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.route).toBe("GET /modern");
    expect(warnings[0]?.message).toContain("already defined differently");
  });

  test("the same definition twice is one scheme and no warning", () => {
    const twin = secured(
      hook.beforeParse(() => undefined),
      {
        name: "apiKey",
        scheme: { type: "apiKey", in: "header", name: "x-legacy-key" },
      },
    );

    class ApiController {
      one = route({
        method: "GET",
        path: "/one",
        hooks: { beforeParse: [legacy] },
        handler: () => ({}),
      });

      two = route({
        method: "GET",
        path: "/two",
        hooks: { beforeParse: [twin] },
        handler: () => ({}),
      });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new ApiController() }),
      { info },
    );

    expect(warnings).toEqual([]);
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual([
      "apiKey",
    ]);
  });

  test("within one route the dropped requirement is reported too", () => {
    const modernLate = secured(
      hook.beforeHandle(() => undefined),
      {
        name: "apiKey",
        scheme: { type: "apiKey", in: "header", name: "x-modern-key" },
      },
    );

    class ApiController {
      both = route({
        method: "GET",
        path: "/both",
        hooks: { beforeParse: [legacy], beforeHandle: [modernLate] },
        handler: () => ({}),
      });
    }

    const { document, warnings } = openapi(
      createApp({ routes: new ApiController() }),
      { info },
    );

    expect(document.paths["/both"]?.get?.security).toEqual([{ apiKey: [] }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("two hooks claim");
  });
});

describe("cookies as parameters", () => {
  const CookieSchema = described<{ session: string; theme?: string }>({
    type: "object",
    properties: {
      session: { type: "string" },
      theme: { type: "string" },
    },
    required: ["session"],
  });

  const app = createApp({
    routes: {
      me: route({
        method: "GET",
        path: "/me",
        schema: { cookies: CookieSchema },
        handler: () => ({ ok: true }),
      }),
      plain: route({
        method: "GET",
        path: "/plain",
        handler: () => ({ ok: true }),
      }),
    },
  });

  const { document } = openapi(app, { info: { title: "t", version: "1.0.0" } });

  test("a declared cookie becomes an in: cookie parameter", () => {
    expect(document.paths?.["/me"]?.get?.parameters).toEqual([
      {
        name: "session",
        in: "cookie",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "theme",
        in: "cookie",
        required: false,
        schema: { type: "string" },
      },
    ]);
  });

  test("a route declaring none has no cookie parameters", () => {
    expect(document.paths?.["/plain"]?.get?.parameters ?? []).toEqual([]);
  });
});

describe("the JSON Schema target a schema is asked for", () => {
  /**
   * Answers the way ArkType and Valibot do: only for the targets the
   * Standard JSON Schema specification names, with `$schema` at the root.
   */
  const strict = <T>(): StandardSchemaV1<unknown, T> => {
    const describe = (options: { target: string }) => {
      if (options.target !== "draft-2020-12") {
        throw new Error(`target '${options.target}' is not supported`);
      }

      return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
    };

    return {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as T }),
        jsonSchema: { input: describe, output: describe },
      },
    } as unknown as StandardSchemaV1<unknown, T>;
  };

  class StrictController {
    create = route({
      method: "POST",
      path: "/strict",
      schema: { body: strict<{ name: string }>() },
      handler: () => null,
    });
  }

  const { document, warnings } = generate(
    createApp({ routes: new StrictController() }),
  );

  test("is draft 2020-12, the dialect of OpenAPI 3.1, which every library knows", () => {
    expect(warnings).toEqual([]);
    expect(
      document.paths["/strict"]?.post?.requestBody?.content["application/json"]
        ?.schema,
    ).toMatchObject({ type: "object", required: ["name"] });
  });

  test("a schema's own $schema is dropped: the document declares the dialect", () => {
    expect(
      document.paths["/strict"]?.post?.requestBody?.content["application/json"]
        ?.schema,
    ).not.toHaveProperty("$schema");
  });
});
