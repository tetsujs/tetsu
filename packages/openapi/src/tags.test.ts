/**
 * Tests for the document's tags: their descriptions, their order, and the
 * warnings that catch a tag spelled two ways.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { docs } from "./controller.ts";
import type { OpenApiDocument } from "./document.ts";
import type { GeneratorWarning } from "./index.ts";
import { openapi } from "./index.ts";

const info = { title: "Tags", version: "1" };

const tagged = (path: string, ...tags: string[]) =>
  route({
    method: "GET",
    path: path as "/x",
    docs: { tags },
    handler: () => ({}),
  });

const app = createApp({
  routes: {
    code: tagged("/code", "sign-in"),
    me: tagged("/me", "me"),
    out: tagged("/out", "sign-in"),
    stats: tagged("/stats", "admin"),
    audit: tagged("/audit", "admin", "audit"),
    open: route({ method: "GET", path: "/open", handler: () => ({}) }),
  },
});

describe("described tags", () => {
  const { document, warnings } = openapi(app, {
    info,
    tags: {
      me: "The signed-in user",
      "sign-in": "Signing in with a code sent by email, and signing out",
      unused: "Nothing uses this",
    },
  });

  test("are listed in the order they were given, with their descriptions", () => {
    expect(document.tags?.slice(0, 3)).toEqual([
      { name: "me", description: "The signed-in user" },
      {
        name: "sign-in",
        description: "Signing in with a code sent by email, and signing out",
      },
      { name: "unused", description: "Nothing uses this" },
    ]);
  });

  test("a tag the routes use and the list does not is added after it", () => {
    expect(document.tags?.slice(3)).toEqual([
      { name: "admin" },
      { name: "audit" },
    ]);
  });

  test("each such tag is reported once, at the first route using it", () => {
    const undescribed = warnings.filter((warning) =>
      warning.message.includes("is not in tags"),
    );

    expect(undescribed).toEqual([
      {
        route: "GET /stats",
        message: expect.stringContaining('"admin"'),
      },
      {
        route: "GET /audit",
        message: expect.stringContaining('"audit"'),
      },
    ]);
  });

  test("a described tag no route uses is reported for the document", () => {
    const unused = warnings.filter((warning) =>
      warning.message.includes('"unused"'),
    );

    expect(unused).toEqual([
      { route: "", message: expect.stringContaining("no operation uses") },
    ]);
  });
});

describe("without tags", () => {
  test("the document lists none, and nothing is reported", () => {
    const { document, warnings } = openapi(app, { info });

    expect(document.tags).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("the documentation controller", () => {
  const read = async (options: Parameters<typeof docs>[0]) => {
    const request = serve(
      createApp({ routes: [{ me: tagged("/me", "me") }, docs(options)] }),
    );

    return (await (await request("/openapi.json")).json()) as OpenApiDocument;
  };

  test("describes its own tag when its routes are in the document", async () => {
    const warned: GeneratorWarning[] = [];

    const document = await read({
      info,
      ui: false,
      documentSelf: true,
      tags: { me: "The signed-in user" },
      onWarning: (warning) => warned.push(warning),
    });

    expect(document.tags).toEqual([
      { name: "me", description: "The signed-in user" },
      { name: "docs", description: "This documentation" },
    ]);
    expect(warned).toEqual([]);
  });

  test("keeps the description the application gave its tag", async () => {
    const document = await read({
      info,
      ui: false,
      documentSelf: true,
      tags: { docs: "Our API reference", me: "The signed-in user" },
    });

    expect(document.tags?.[0]).toEqual({
      name: "docs",
      description: "Our API reference",
    });
  });

  test("adds nothing when its routes stay out of the document", async () => {
    const document = await read({
      info,
      ui: false,
      tags: { me: "The signed-in user" },
    });

    expect(document.tags).toEqual([
      { name: "me", description: "The signed-in user" },
    ]);
  });
});
