/**
 * Runtime tests for the TypeBox adapter.
 *
 * @module
 */

import { describe, expect, spyOn, test } from "bun:test";
import type {
  StandardJSONSchemaV1,
  StandardResult,
  StandardSchemaV1,
} from "@tetsujs/core";
import { Type } from "typebox";
import { Validator } from "typebox/compile";
import Value from "typebox/value";
import * as adapter from "./index.ts";
import { tb } from "./index.ts";

const props = <T>(schema: T) =>
  (schema as StandardSchemaV1 & StandardJSONSchemaV1)["~standard"];

const validate = (schema: unknown, value: unknown) =>
  props(schema).validate(value) as StandardResult<unknown>;

const Item = tb(
  Type.Object({
    qty: Type.Number(),
    name: Type.String({ minLength: 1 }),
  }),
);

describe("validation", () => {
  test("accepts a valid value", () => {
    expect(validate(Item, { qty: 2, name: "box" })).toEqual({
      value: { qty: 2, name: "box" },
    });
  });

  test("reports issues with JSON-pointer paths turned into segments", () => {
    const result = validate(Item, { qty: "two", name: "box" });

    expect(result.issues?.[0]?.path).toEqual(["qty"]);
    expect(result.issues?.[0]?.message).toContain("number");
  });

  test("reports nested and indexed paths", () => {
    const Nested = tb(
      Type.Object({ items: Type.Array(Type.Object({ id: Type.String() })) }),
    );

    const result = validate(Nested, { items: [{ id: 1 }] });

    expect(result.issues?.[0]?.path).toEqual(["items", 0, "id"]);
  });

  test("does not coerce by default", () => {
    expect(validate(Item, { qty: "2", name: "box" }).issues).toBeDefined();
  });

  test("a missing property is reported at its own path, one issue each", () => {
    const result = validate(Item, {});

    expect(result.issues).toEqual([
      { message: "is required", path: ["qty"] },
      { message: "is required", path: ["name"] },
    ]);
  });

  test("a nested missing property keeps the path of its parent", () => {
    const Nested = tb(
      Type.Object({ item: Type.Object({ id: Type.String() }) }),
    );

    const result = validate(Nested, { item: {} });

    expect(result.issues).toEqual([
      { message: "is required", path: ["item", "id"] },
    ]);
  });

  test("an unexpected property is reported at its own path", () => {
    const Strict = tb(
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
    );

    const result = validate(Strict, { id: "a", role: "admin" });

    expect(result.issues).toEqual([
      {
        message: "is not a property this schema declares",
        path: ["role"],
      },
    ]);
  });
});

describe("a schema built from codecs", () => {
  const Stored = tb(
    Type.Object({
      count: Type.Codec(Type.String({ pattern: "^\\d+$" }))
        .Decode(Number)
        .Encode(String),
      at: Type.Codec(Type.String({ format: "date-time" }))
        .Decode((value) => new Date(value))
        .Encode((value: Date) => value.toISOString()),
    }),
  );

  test("validates the stored shape and returns the decoded one", () => {
    const result = validate(Stored, {
      count: "3",
      at: "2026-08-20T10:00:00.000Z",
    });

    expect(result.issues).toBeUndefined();
    expect((result as { value: unknown }).value).toEqual({
      count: 3,
      at: new Date("2026-08-20T10:00:00.000Z"),
    });
  });

  test("stays a TypeBox schema, so it can still be encoded", () => {
    const encoded = Value.Encode(Stored, {
      count: 3,
      at: new Date("2026-08-20T10:00:00.000Z"),
    });

    expect(encoded).toEqual({ count: "3", at: "2026-08-20T10:00:00.000Z" });
  });

  test("rejects on the stored shape, before decoding", () => {
    expect(validate(Stored, { count: "many", at: "yesterday" }).issues).toEqual(
      [
        { message: 'must match pattern "^\\d+$"', path: ["count"] },
        { message: 'must match format "date-time"', path: ["at"] },
      ],
    );
  });
});

describe("a union of literals", () => {
  const Dto = tb(
    Type.Object({
      level: Type.Union([
        Type.Literal("debug"),
        Type.Literal("info"),
        Type.Literal("warn"),
      ]),
    }),
  );

  test("fails once, naming the values it allows", () => {
    expect(validate(Dto, { level: "verbose" }).issues).toEqual([
      { message: 'must be one of "debug", "info", "warn"', path: ["level"] },
    ]);
  });

  test("passes what it allows", () => {
    expect(validate(Dto, { level: "warn" }).issues).toBeUndefined();
  });

  test("Type.Enum says the same thing", () => {
    const Enumerated = tb(
      Type.Object({
        level: Type.Enum({ debug: "debug", info: "info", warn: "warn" }),
      }),
    );

    expect(validate(Enumerated, { level: "verbose" }).issues).toEqual([
      { message: 'must be one of "debug", "info", "warn"', path: ["level"] },
    ]);
  });

  test("a union of objects keeps the failure of every member", () => {
    const Shapes = tb(
      Type.Union([
        Type.Object({ kind: Type.Literal("a"), a: Type.String() }),
        Type.Object({ kind: Type.Literal("b"), b: Type.String() }),
      ]),
    );

    const issues = validate(Shapes, { kind: "a" }).issues ?? [];

    expect(issues.length).toBeGreaterThan(1);
    expect(issues.map((issue) => issue.message)).toContain("is required");
  });

  test("the schema can still name the failure itself", () => {
    const Named = tb(
      Type.Object({
        level: Type.Union([Type.Literal("debug"), Type.Literal("info")], {
          errorMessage: "unknown log level",
        }),
      }),
    );

    expect(validate(Named, { level: "verbose" }).issues).toEqual([
      { message: "unknown log level", path: ["level"] },
    ]);
  });
});

describe("messages declared by the schema", () => {
  test("a string covers every way the node can fail", () => {
    const Dto = tb(
      Type.Object({
        password: Type.String({ minLength: 8, errorMessage: "8 characters" }),
      }),
    );

    expect(validate(Dto, { password: "short" }).issues).toEqual([
      { message: "8 characters", path: ["password"] },
    ]);
    expect(validate(Dto, { password: 42 }).issues).toEqual([
      { message: "8 characters", path: ["password"] },
    ]);
  });

  test("an object names the keywords it overrides", () => {
    const Dto = tb(
      Type.Object({
        email: Type.String({
          format: "email",
          errorMessage: { format: "Not an email" },
        }),
      }),
    );

    expect(validate(Dto, { email: "nope" }).issues).toEqual([
      { message: "Not an email", path: ["email"] },
    ]);
    expect(validate(Dto, { email: 42 }).issues).toEqual([
      { message: "must be string", path: ["email"] },
    ]);
  });

  test("a missing property takes the message of the property", () => {
    const Dto = tb(
      Type.Object({
        email: Type.String({ errorMessage: { required: "Email is required" } }),
        password: Type.String({ errorMessage: "Pick a password" }),
      }),
    );

    expect(validate(Dto, {}).issues).toEqual([
      { message: "Email is required", path: ["email"] },
      { message: "Pick a password", path: ["password"] },
    ]);
  });

  test("an unexpected property takes the message of the object", () => {
    const Dto = tb(
      Type.Object(
        { id: Type.String() },
        {
          additionalProperties: false,
          errorMessage: { additionalProperties: "Unknown field" },
        },
      ),
    );

    expect(validate(Dto, { id: "a", role: "admin" }).issues).toEqual([
      { message: "Unknown field", path: ["role"] },
    ]);
  });

  test("nested and indexed nodes resolve too", () => {
    const Dto = tb(
      Type.Object({
        items: Type.Array(
          Type.Object({
            qty: Type.Integer({ minimum: 1, errorMessage: "At least one" }),
          }),
        ),
      }),
    );

    expect(validate(Dto, { items: [{ qty: 0 }] }).issues).toEqual([
      { message: "At least one", path: ["items", 0, "qty"] },
    ]);
  });

  test("a member of a union carries its own message", () => {
    const Dto = tb(
      Type.Union([
        Type.Object({
          kind: Type.Literal("a", { errorMessage: "kind must be a" }),
        }),
        Type.Object({ kind: Type.Literal("b") }),
      ]),
    );

    expect(validate(Dto, { kind: "c" }).issues?.[0]).toEqual({
      message: "kind must be a",
      path: ["kind"],
    });
  });

  test("a keyword the map does not name keeps TypeBox's wording", () => {
    const Dto = tb(
      Type.Object({
        name: Type.String({
          minLength: 2,
          errorMessage: { type: "Must be text" },
        }),
      }),
    );

    expect(validate(Dto, { name: "x" }).issues?.[0]?.message).toBe(
      "must not have fewer than 2 characters",
    );
  });

  test("the keyword never reaches the emitted JSON Schema", () => {
    const Dto = tb(
      Type.Object({
        email: Type.String({ errorMessage: "Not an email" }),
      }),
    );

    expect(
      Dto["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    ).toEqual({
      type: "object",
      required: ["email"],
      properties: { email: { type: "string" } },
    });
  });
});

describe("convert option", () => {
  const Params = tb(Type.Object({ id: Type.Integer() }), { convert: true });

  test("coerces string input", () => {
    expect(validate(Params, { id: "42" })).toEqual({ value: { id: 42 } });
  });

  test("still rejects what cannot be coerced", () => {
    expect(validate(Params, { id: "abc" }).issues).toBeDefined();
  });

  test("coerces into a copy, leaving the input untouched", () => {
    const input = { id: "42" };

    expect(validate(Params, input)).toEqual({ value: { id: 42 } });
    expect(input).toEqual({ id: "42" });
  });
});

describe("clean option", () => {
  test("strips undeclared properties", () => {
    const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });

    expect(validate(PublicUser, { id: "u1", passwordHash: "secret" })).toEqual({
      value: { id: "u1" },
    });
  });

  test("keeps extra properties when disabled", () => {
    const Loose = tb(Type.Object({ id: Type.String() }));

    expect(validate(Loose, { id: "u1", extra: 1 })).toEqual({
      value: { id: "u1", extra: 1 },
    });
  });

  test("strips a copy, leaving the input untouched", () => {
    const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });
    const input = { id: "u1", passwordHash: "secret" };

    expect(validate(PublicUser, input)).toEqual({ value: { id: "u1" } });
    expect(input).toEqual({ id: "u1", passwordHash: "secret" });
  });

  test("strips nested objects without touching the input", () => {
    const Envelope = tb(
      Type.Object({ user: Type.Object({ id: Type.String() }) }),
      { clean: true },
    );
    const nested = { id: "u1", passwordHash: "secret" };

    expect(validate(Envelope, { user: nested })).toEqual({
      value: { user: { id: "u1" } },
    });
    expect(nested).toEqual({ id: "u1", passwordHash: "secret" });
  });
});

describe("dual nature", () => {
  test("serializes as clean JSON Schema", () => {
    expect(JSON.parse(JSON.stringify(Item))).toEqual({
      type: "object",
      required: ["qty", "name"],
      properties: {
        qty: { type: "number" },
        name: { type: "string", minLength: 1 },
      },
    });
  });

  test("nests into other TypeBox schemas", () => {
    const Envelope = Type.Object({ item: Item });

    expect(JSON.parse(JSON.stringify(Envelope))).toEqual({
      type: "object",
      required: ["item"],
      properties: {
        item: {
          type: "object",
          required: ["qty", "name"],
          properties: {
            qty: { type: "number" },
            name: { type: "string", minLength: 1 },
          },
        },
      },
    });
  });

  test("leaves the source schema untouched", () => {
    const source = Type.Object({ id: Type.String() });

    tb(source);

    expect(Object.hasOwn(source, "~standard")).toBe(false);
  });

  test("keeps schema keywords available to documentation", () => {
    const json = props(Item).jsonSchema.output({ target: "draft-2020-12" });

    expect(json).toMatchObject({
      properties: { name: { minLength: 1 } },
    });
  });
});

describe("json schema targets", () => {
  test("emits for openapi-3.1 and draft-2020-12", () => {
    expect(props(Item).jsonSchema.output({ target: "openapi-3.1" })).toEqual(
      props(Item).jsonSchema.input({ target: "draft-2020-12" }),
    );
  });

  test("throws for dialects it cannot emit faithfully", () => {
    expect(() => props(Item).jsonSchema.output({ target: "draft-07" })).toThrow(
      'target "draft-07" is not supported',
    );
  });
});

describe("TypeBox, from this package", () => {
  test("Type is TypeBox's own, not a copy", () => {
    expect(adapter.Type).toBe(Type);
  });
});

describe("issues option", () => {
  const Order = Type.Object({
    items: Type.Array(
      Type.Object({
        qty: Type.Integer({ minimum: 1, errorMessage: "at least one" }),
      }),
    ),
  });

  const invalid = { items: [{ qty: 1 }, { qty: 0 }] };

  test("detailed, the default, reports each failure where it is", () => {
    expect(validate(tb(Order), invalid).issues).toEqual([
      { message: "at least one", path: ["items", 1, "qty"] },
    ]);
  });

  test("summary reports one failure for the whole value", () => {
    expect(validate(tb(Order, { issues: "summary" }), invalid).issues).toEqual([
      { message: "does not match the schema" },
    ]);
  });

  test("summary never asks TypeBox what went wrong", () => {
    const errors = spyOn(Validator.prototype, "Errors");

    try {
      validate(tb(Order, { issues: "summary" }), invalid);

      expect(errors).not.toHaveBeenCalled();

      validate(tb(Order), invalid);

      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("summary changes nothing for a value that passes", () => {
    const Dto = tb(Type.Object({ qty: Type.Integer({ default: 1 }) }), {
      issues: "summary",
      defaults: true,
    });

    expect(validate(Dto, {})).toEqual({ value: { qty: 1 } });
  });
});

describe("a DTO wrapped again", () => {
  test("takes the options it is given now", () => {
    const Detailed = tb(Type.Object({ qty: Type.Integer({ minimum: 1 }) }));
    const Summarized = tb(Detailed, { issues: "summary" });

    expect(validate(Summarized, { qty: 0 }).issues).toEqual([
      { message: "does not match the schema" },
    ]);
    expect(validate(Detailed, { qty: 0 }).issues).toEqual([
      { message: "must be >= 1", path: ["qty"] },
    ]);
  });

  test("and only those: what the earlier call turned on is off", () => {
    const Coerced = tb(Type.Object({ qty: Type.Integer() }), {
      convert: true,
    });
    const Summarized = tb(Coerced, { issues: "summary" });

    expect(validate(Coerced, { qty: "5" })).toEqual({ value: { qty: 5 } });
    expect(validate(Summarized, { qty: "5" }).issues).toEqual([
      { message: "does not match the schema" },
    ]);
  });
});
