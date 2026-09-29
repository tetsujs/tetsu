/**
 * Tests for the references a validator's schema brings into the document.
 *
 * The schemas here are written the way the libraries emit them: Zod's
 * recursive schema refers to its root as `#`, and its named ones — like
 * ArkType's scopes and Valibot's `lazy` — to `#/$defs/…` next to the root.
 * Embedded in a document, those resolve against the document's root, and
 * the generator says so rather than returning a document that is invalid
 * without a word.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import type { JsonSchema } from "./index.ts";
import { documented, openapi } from "./index.ts";

const described = (jsonSchema: Record<string, unknown>): StandardSchemaV1 =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1;

const warningsFor = (response: StandardSchemaV1) =>
  openapi(
    createApp({
      routes: {
        tree: route({
          method: "GET",
          path: "/tree",
          schema: { response: { 200: response } },
          handler: () => undefined as never,
        }),
      },
    }),
    { info: { title: "Refs", version: "1" } },
  ).warnings;

describe("references a schema brings with it", () => {
  test("a recursive schema's reference to its root is reported", () => {
    const Node = described({
      type: "object",
      properties: {
        name: { type: "string" },
        children: { type: "array", items: { $ref: "#" } },
      },
    });

    expect(warningsFor(Node)).toEqual([
      {
        route: "GET /tree",
        message: `a schema refers to "#", which is no schema in the document: references are embedded as they are, and resolve against the document's root`,
      },
    ]);
  });

  test("so is a reference to a definition next to the root, once", () => {
    const Tree = described({
      type: "object",
      properties: {
        left: { $ref: "#/$defs/Node" },
        right: { $ref: "#/$defs/Node" },
      },
      $defs: { Node: { type: "object" } },
    });

    expect(warningsFor(Tree).map((warning) => warning.message)).toEqual([
      `a schema refers to "#/$defs/Node", which is no schema in the document: references are embedded as they are, and resolve against the document's root`,
    ]);
  });

  test("references within a schema with an $id resolve against it", () => {
    const Node = described({
      $id: "Node",
      type: "object",
      properties: {
        children: { type: "array", items: { $ref: "#" } },
        parent: { $ref: "#/properties/children" },
      },
    });

    expect(warningsFor(Node)).toEqual([]);
  });

  test("a reference that is not local is left alone", () => {
    const Node = described({
      $id: "Node",
      type: "object",
      properties: { children: { type: "array", items: { $ref: "Node" } } },
    });

    expect(warningsFor(Node)).toEqual([]);
  });

  test("a reference to what the document defines is not reported", () => {
    const Refused = described({
      type: "object",
      properties: {
        cause: { $ref: "#/components/schemas/InternalServerError" },
      },
    });

    expect(warningsFor(Refused)).toEqual([]);
  });

  test("a $ref that is an example's data is not a reference", () => {
    const Link = described({
      type: "object",
      properties: { $ref: { type: "string" } },
      examples: [{ $ref: "#/elsewhere" }],
    });

    expect(warningsFor(Link)).toEqual([]);
  });

  test("a hook's field that refers to nothing is reported for its component", () => {
    const cause: JsonSchema = { $ref: "#/$defs/Cause" };
    const limited = documented(
      hook.beforeParse(() => undefined),
      {
        responses: [
          {
            status: 429,
            description: "Too many requests",
            error: "RATE_LIMITED",
            fields: { cause },
          },
        ],
      },
    );

    const { warnings } = openapi(
      createApp({
        routes: {
          list: route({
            method: "GET",
            path: "/items",
            hooks: { beforeParse: [limited] },
            handler: () => [],
          }),
        },
      }),
      { info: { title: "Refs", version: "1" } },
    );

    expect(warnings).toEqual([
      {
        route: "",
        message: `components/schemas/RateLimited refers to "#/$defs/Cause", which is no schema in the document: references are embedded as they are, and resolve against the document's root`,
      },
    ]);
  });
});
