/**
 * Tests for how a route of files appears in the OpenAPI document: not at
 * all by default, and described by the handler when the route shows it.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteDocs } from "@tetsujs/core";
import { createApp, route } from "@tetsujs/core";
import type { OpenApiDocument, ResponseObject } from "@tetsujs/openapi";
import { openapi } from "@tetsujs/openapi";
import type { StaticOptions } from "./index.ts";
import { staticFiles } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "tetsu-static-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

writeFileSync(join(root, "index.html"), "<h1>Home</h1>");
writeFileSync(join(root, "404.html"), "<h1>Not here</h1>");

const info = { title: "Shop", version: "1.0.0" };

/** The document of an application with one route of files at `/downloads/*`. */
function documentOf(options: StaticOptions, docs?: RouteDocs): OpenApiDocument {
  const app = createApp({
    routes: [
      route({
        method: "GET",
        path: "/downloads/*",
        handler: staticFiles(options),
        ...(docs === undefined ? {} : { docs }),
      }),
    ],
  });

  return openapi(app, { info }).document;
}

/** The responses of the route of files, by status. */
function responsesOf(
  document: OpenApiDocument,
): Record<string, ResponseObject> {
  const operation = document.paths?.["/downloads/{wildcard}"]?.get;

  expect(operation).toBeDefined();

  return (operation?.responses ?? {}) as Record<string, ResponseObject>;
}

describe("a route of files", () => {
  test("is left out of the document", () => {
    expect(documentOf({ root }).paths).toEqual({});
  });

  test("stays out when the route says hidden itself", () => {
    expect(documentOf({ root }, { hidden: true }).paths).toEqual({});
  });

  test("shown, is a file of any type with its headers", () => {
    const responses = responsesOf(documentOf({ root }, { hidden: false }));

    expect(Object.keys(responses)).toEqual([
      "200",
      "206",
      "301",
      "304",
      "404",
      "416",
      "500",
    ]);
    expect(Object.keys(responses["200"]?.content ?? {})).toEqual(["*/*"]);
    expect(Object.keys(responses["200"]?.headers ?? {})).toEqual([
      "etag",
      "cache-control",
      "last-modified",
      "accept-ranges",
    ]);
    expect(Object.keys(responses["206"]?.headers ?? {})).toContain(
      "content-range",
    );
    expect(responses["301"]?.content).toBeUndefined();
    expect(Object.keys(responses["301"]?.headers ?? {})).toEqual(["location"]);
    expect(responses["304"]?.content).toBeUndefined();
    expect(Object.keys(responses["304"]?.headers ?? {})).toEqual([
      "etag",
      "cache-control",
    ]);
    expect(Object.keys(responses["404"]?.content ?? {})).toEqual([
      "application/json",
    ]);
    expect(Object.keys(responses["416"]?.content ?? {})).toEqual(["*/*"]);
  });

  test("shown with notFound, has the page among its 404s", () => {
    const responses = responsesOf(
      documentOf({ root, notFound: "404.html" }, { hidden: false }),
    );

    expect(Object.keys(responses["404"]?.content ?? {})).toEqual([
      "application/json",
      "text/html",
    ]);
  });

  test("shown with precompressed, says which encoding was sent", () => {
    const responses = responsesOf(
      documentOf({ root, precompressed: true }, { hidden: false }),
    );

    expect(Object.keys(responses["200"]?.headers ?? {})).toContain(
      "content-encoding",
    );
    expect(Object.keys(responses["200"]?.headers ?? {})).toContain("vary");
    expect(Object.keys(responses["304"]?.headers ?? {})).toEqual([
      "etag",
      "cache-control",
      "vary",
    ]);
  });

  test("wrapped in an arrow, tells the document nothing", () => {
    const files = staticFiles({ root });
    const wrapped = (hidden: boolean | undefined) =>
      openapi(
        createApp({
          routes: [
            route({
              method: "GET",
              path: "/downloads/*",
              ...(hidden === undefined ? {} : { docs: { hidden } }),
              handler: (ctx) => files(ctx),
            }),
          ],
        }),
        { info },
      ).document;

    expect(Object.keys(responsesOf(wrapped(undefined)))).toEqual([
      "200",
      "500",
    ]);
    expect(wrapped(true).paths).toEqual({});
  });

  test("shown with index: false, redirects no directory", () => {
    const responses = responsesOf(
      documentOf({ root, index: false }, { hidden: false }),
    );

    expect(responses["301"]).toBeUndefined();
  });
});
