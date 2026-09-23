/**
 * Runtime tests for JSON Schema extraction.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "./schema.ts";
import { toJsonSchema } from "./schema.ts";

const convertible: StandardJSONSchemaV1<unknown, { id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    jsonSchema: {
      input: (options) => ({ type: "object", target: options.target }),
      output: (options) => ({ type: "object", target: options.target }),
    },
  },
};

const plain: StandardSchemaV1<unknown, { id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as { id: string } }),
  },
};

describe("toJsonSchema", () => {
  test("reads the converter of a convertible schema", () => {
    expect(toJsonSchema(convertible, { target: "openapi-3.0" })).toEqual({
      type: "object",
      target: "openapi-3.0",
    });
  });

  test("returns undefined for schemas without a converter", () => {
    expect(toJsonSchema(plain, { target: "draft-2020-12" })).toBeUndefined();
  });

  test("returns undefined for non-schema values", () => {
    expect(toJsonSchema(null, { target: "draft-07" })).toBeUndefined();
    expect(toJsonSchema({}, { target: "draft-07" })).toBeUndefined();
  });
});
