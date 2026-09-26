/**
 * Tests for the mountable documentation controller.
 *
 * These go over a live server: what is being tested is that mounting
 * `docs()` is all an application has to do, and that includes the routes
 * actually answering.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, group, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { docs } from "./controller.ts";
import type { OpenApiDocument } from "./document.ts";

const info = { title: "Users API", version: "1.0.0" };

const users = {
  list: route({ method: "GET", path: "/users", handler: () => [] }),
};

describe("docs()", () => {
  const request = serve(
    createApp({
      routes: [group("/api", { children: [users] }), docs({ info })],
    }),
  );

  test("serves the document at /openapi.json", async () => {
    const res = await request("/openapi.json");

    expect(res.status).toBe(200);

    const document = (await res.json()) as OpenApiDocument;

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual(info);
    expect(Object.keys(document.paths).toSorted()).toEqual(["/api/users"]);
  });

  test("serves the page at /docs", async () => {
    const res = await request("/docs");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await res.text();

    expect(html).toContain('data-url="/openapi.json"');
    expect(html).toContain("<title>Users API</title>");
  });
});

describe("docs({ ui: false })", () => {
  const request = serve(
    createApp({ routes: [users, docs({ info, ui: false })] }),
  );

  test("serves the document", async () => {
    const res = await request("/openapi.json");

    expect(res.status).toBe(200);
    expect(((await res.json()) as OpenApiDocument).info).toEqual(info);
  });

  test("serves no page", async () => {
    expect((await request("/docs")).status).toBe(404);
  });
});

describe("options", () => {
  test("the paths are the application's to choose", async () => {
    const request = serve(
      createApp({
        routes: [
          users,
          docs({ info, path: "/spec.json", uiPath: "/reference" }),
        ],
      }),
    );

    expect((await request("/spec.json")).status).toBe(200);
    expect((await request("/openapi.json")).status).toBe(404);

    const html = await (await request("/reference")).text();

    expect(html).toContain('data-url="/spec.json"');
  });

  test("the renderer and the browser title are too", async () => {
    const request = serve(
      createApp({
        routes: [users, docs({ info, ui: "redoc", title: "Reference" })],
      }),
    );

    const html = await (await request("/docs")).text();

    expect(html).toContain('<redoc spec-url="/openapi.json">');
    expect(html).toContain("<title>Reference</title>");
  });

  test("servers reach the document", async () => {
    const request = serve(
      createApp({
        routes: [
          users,
          docs({ info, servers: [{ url: "https://api.example.com" }] }),
        ],
      }),
    );

    const document = (await (
      await request("/openapi.json")
    ).json()) as OpenApiDocument;

    expect(document.servers).toEqual([{ url: "https://api.example.com" }]);
  });

  test("warnings are reported to the caller instead of the console", () => {
    const seen: string[] = [];

    createApp({
      routes: [
        {
          create: route({
            method: "POST",
            path: "/users",
            schema: {
              body: {
                "~standard": {
                  version: 1,
                  vendor: "test",
                  validate: (value: unknown) => ({ value }),
                },
              },
            },
            handler: () => undefined,
          }),
        },
        docs({ info, onWarning: (warning) => seen.push(warning.message) }),
      ],
    });

    expect(seen).toEqual(["the body schema does not emit JSON Schema"]);
  });

  test("a converter that throws is a warning, not a server that never starts", () => {
    const seen: string[] = [];

    const app = createApp({
      routes: [
        {
          create: route({
            method: "POST",
            path: "/users",
            schema: {
              body: {
                "~standard": {
                  version: 1,
                  vendor: "test",
                  validate: (value: unknown) => ({ value }),
                  jsonSchema: {
                    input: () => {
                      throw new Error("converter gave up");
                    },
                    output: () => {
                      throw new Error("converter gave up");
                    },
                  },
                },
              },
            },
            handler: () => undefined,
          }),
        },
        docs({ info, onWarning: (warning) => seen.push(warning.message) }),
      ],
    });

    expect(app.entries.length).toBeGreaterThan(0);
    expect(seen).toEqual([
      "the body schema failed to emit JSON Schema: converter gave up",
    ]);
  });
});

describe("documenting itself", () => {
  test("the documentation endpoints stay out of the document", async () => {
    const request = serve(createApp({ routes: [users, docs({ info })] }));

    const document = (await (
      await request("/openapi.json")
    ).json()) as OpenApiDocument;

    expect(Object.keys(document.paths)).toEqual(["/users"]);
  });

  test("unless the application asks for them", async () => {
    const request = serve(
      createApp({ routes: [users, docs({ info, documentSelf: true })] }),
    );

    const document = (await (
      await request("/openapi.json")
    ).json()) as OpenApiDocument;

    expect(Object.keys(document.paths).toSorted()).toEqual([
      "/docs",
      "/openapi.json",
      "/users",
    ]);

    expect(document.paths["/openapi.json"]?.get?.summary).toBe("This document");
  });
});

describe("mounting", () => {
  test("a group prefixes the documentation endpoints like any controller", async () => {
    const request = serve(
      createApp({
        routes: [users, group("/internal", { children: [docs({ info })] })],
      }),
    );

    expect((await request("/internal/openapi.json")).status).toBe(200);
    expect((await request("/internal/docs")).status).toBe(200);
  });

  test("the page fetches the document where the group put it", async () => {
    const request = serve(
      createApp({
        routes: [
          users,
          group("/internal", {
            children: [docs({ info, path: "/spec.json", ui: "redoc" })],
          }),
        ],
      }),
    );

    const html = await (await request("/internal/docs")).text();

    expect(html).toContain('spec-url="/internal/spec.json"');
  });
});
