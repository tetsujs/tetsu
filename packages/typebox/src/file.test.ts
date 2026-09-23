/**
 * Runtime tests for the file schemas.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type {
  StandardJSONSchemaV1,
  StandardResult,
  StandardSchemaV1,
} from "@tetsujs/core";
import { Type } from "typebox";
import { file, files } from "./file.ts";
import { tb } from "./index.ts";

const props = <T>(schema: T) =>
  (schema as StandardSchemaV1 & StandardJSONSchemaV1)["~standard"];

const validate = (schema: unknown, value: unknown) =>
  props(schema).validate(value) as StandardResult<unknown>;

const emitted = (schema: unknown) =>
  props(schema).jsonSchema.input({ target: "openapi-3.1" });

const png = (name = "a.png", size = 4) =>
  new File(["x".repeat(size)], name, { type: "image/png" });

describe("file()", () => {
  test("accepts a File and rejects anything else", () => {
    const Dto = tb(Type.Object({ avatar: file() }));

    expect(validate(Dto, { avatar: png() }).issues).toBeUndefined();
    expect(validate(Dto, { avatar: "not a file" }).issues?.[0]?.message).toBe(
      "expected a file",
    );
  });

  test("enforces maxSize in bytes and with unit suffixes", () => {
    const Bytes = tb(Type.Object({ avatar: file({ maxSize: 8 }) }));
    const Kilo = tb(Type.Object({ avatar: file({ maxSize: "1k" }) }));

    expect(validate(Bytes, { avatar: png("a.png", 4) }).issues).toBeUndefined();
    expect(validate(Bytes, { avatar: png("a.png", 16) }).issues?.[0]).toEqual({
      message: "file must be at most 8 bytes",
      path: ["avatar"],
    });
    expect(
      validate(Kilo, { avatar: png("a.png", 512) }).issues,
    ).toBeUndefined();
    expect(
      validate(Kilo, { avatar: png("a.png", 2048) }).issues?.[0]?.message,
    ).toBe("file must be at most 1024 bytes");
  });

  test("pins the maxSize boundary on both sides", () => {
    const Dto = tb(Type.Object({ avatar: file({ maxSize: 8 }) }));

    // Exactly the limit passes; one byte over does not. Neither side was
    // covered: the existing case steps from 4 to 16, which no off-by-one
    // in either direction can fall into.
    expect(validate(Dto, { avatar: png("a.png", 8) }).issues).toBeUndefined();
    expect(validate(Dto, { avatar: png("a.png", 9) }).issues?.[0]).toEqual({
      message: "file must be at most 8 bytes",
      path: ["avatar"],
    });
  });

  test("enforces minSize", () => {
    const Dto = tb(Type.Object({ avatar: file({ minSize: 4 }) }));

    expect(validate(Dto, { avatar: png("a.png", 4) }).issues).toBeUndefined();
    expect(
      validate(Dto, { avatar: png("a.png", 1) }).issues?.[0]?.message,
    ).toBe("file must be at least 4 bytes");
  });

  test("matches a MIME family by prefix and a full type exactly", () => {
    const Family = tb(Type.Object({ avatar: file({ type: "image" }) }));
    const Exact = tb(Type.Object({ avatar: file({ type: "image/png" }) }));

    const webp = new File(["x"], "a.webp", { type: "image/webp" });

    expect(validate(Family, { avatar: webp }).issues).toBeUndefined();
    expect(validate(Exact, { avatar: webp }).issues?.[0]?.message).toBe(
      "file type must be image/png",
    );
  });

  test("accepts several types", () => {
    const Dto = tb(
      Type.Object({ avatar: file({ type: ["image", "application/pdf"] }) }),
    );

    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const text = new File(["x"], "a.txt", { type: "text/plain" });

    expect(validate(Dto, { avatar: pdf }).issues).toBeUndefined();
    expect(validate(Dto, { avatar: text }).issues?.[0]?.message).toBe(
      "file type must be image or application/pdf",
    );
  });

  test("rejects an unknown size suffix at declaration", () => {
    expect(() => file({ maxSize: "5g" as never })).toThrow(
      'must be "k" or "m"',
    );
  });
});

describe("files()", () => {
  test("normalizes a single file into an array", () => {
    const Dto = tb(Type.Object({ gallery: files() }));

    const result = validate(Dto, { gallery: png() }) as {
      value?: { gallery: File[] };
    };

    expect(result.value?.gallery).toHaveLength(1);
    expect(result.value?.gallery[0]?.name).toBe("a.png");
  });

  test("keeps an array as it is", () => {
    const Dto = tb(Type.Object({ gallery: files() }));

    const result = validate(Dto, {
      gallery: [png("a.png"), png("b.png")],
    }) as { value?: { gallery: File[] } };

    expect(result.value?.gallery.map((entry) => entry.name)).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  test("applies its constraints to every member", () => {
    const Dto = tb(Type.Object({ gallery: files({ maxSize: 8 }) }));

    const issues = validate(Dto, {
      gallery: [png("a.png", 4), png("b.png", 32)],
    }).issues;

    expect(issues?.[0]?.message).toBe("file must be at most 8 bytes");
  });

  test("pins the maxSize boundary for every member too", () => {
    const Dto = tb(Type.Object({ gallery: files({ maxSize: 8 }) }));

    expect(
      validate(Dto, { gallery: [png("a.png", 8), png("b.png", 8)] }).issues,
    ).toBeUndefined();
    expect(
      validate(Dto, { gallery: [png("a.png", 8), png("b.png", 9)] }).issues?.[0]
        ?.message,
    ).toBe("file must be at most 8 bytes");
  });

  test("rejects a non-file member", () => {
    const Dto = tb(Type.Object({ gallery: files() }));

    expect(validate(Dto, { gallery: ["text"] }).issues).toBeDefined();
  });
});

describe("emitted JSON Schema", () => {
  test("describes a file as a binary string", () => {
    const Dto = tb(
      Type.Object({ avatar: file({ maxSize: "1k", type: "image" }) }),
    );

    expect(emitted(Dto)).toEqual({
      type: "object",
      required: ["avatar"],
      properties: {
        avatar: {
          type: "string",
          contentEncoding: "binary",
          contentMediaType: "image",
          maxLength: 1024,
        },
      },
    });
  });

  test("describes files as an array of them", () => {
    const Dto = tb(Type.Object({ gallery: files({ minSize: 1 }) }));

    expect(emitted(Dto)).toEqual({
      type: "object",
      required: ["gallery"],
      properties: {
        gallery: {
          type: "array",
          items: {
            type: "string",
            contentEncoding: "binary",
            minLength: 1,
          },
        },
      },
    });
  });

  test("leaves ordinary fields untouched", () => {
    const Dto = tb(
      Type.Object({ title: Type.String({ minLength: 1 }), avatar: file() }),
    );

    expect(emitted(Dto)).toMatchObject({
      properties: { title: { type: "string", minLength: 1 } },
    });
  });

  test("the documentation shape never leaks into the schema itself", () => {
    const Dto = tb(Type.Object({ avatar: file({ maxSize: "1k" }) }));

    expect(JSON.stringify(Dto)).not.toContain("file-docs");
    expect(JSON.stringify(Dto)).not.toContain("contentEncoding");
  });
});
