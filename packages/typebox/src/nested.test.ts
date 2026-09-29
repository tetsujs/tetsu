/**
 * Tests for a DTO inside another DTO.
 *
 * A schema checks as one tree: the outer `tb()` compiles the whole of it,
 * and its options are the ones applied — the options of a DTO nested in it
 * are not. A `PublicUser` declared with `clean: true` and listed in a page
 * of users used to lose its `clean` without a word, and the fields it was
 * declared to strip went out in the response. A nested DTO that asks for
 * more than the schema around it is refused where the outer one is made.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardResult, StandardSchemaV1 } from "@tetsujs/core";
import { Type, tb } from "./index.ts";

const validate = (schema: unknown, value: unknown) =>
  (schema as StandardSchemaV1)["~standard"].validate(
    value,
  ) as StandardResult<unknown>;

const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });

describe("options of a nested DTO", () => {
  test("a nested clean the outer schema does not have is refused", () => {
    expect(() => tb(Type.Object({ users: Type.Array(PublicUser) }))).toThrow(
      /clean/,
    );
  });

  test("so are convert and defaults", () => {
    const Page = tb(Type.Object({ size: Type.Integer({ default: 20 }) }), {
      convert: true,
      defaults: true,
    });

    expect(() => tb(Type.Object({ page: Page }))).toThrow(/convert, defaults/);
    expect(() => tb(Type.Object({ page: Page }), { convert: true })).toThrow(
      /defaults/,
    );
  });

  test("however deep, and inside an optional or a union", () => {
    expect(() =>
      tb(
        Type.Object({
          data: Type.Object({
            owner: Type.Optional(Type.Union([PublicUser, Type.Null()])),
          }),
        }),
      ),
    ).toThrow(/clean/);
  });

  test("with the option on the outer schema, the nested fields are stripped", () => {
    const UserList = tb(Type.Object({ users: Type.Array(PublicUser) }), {
      clean: true,
    });

    expect(
      validate(UserList, { users: [{ id: "u1", passwordHash: "secret" }] }),
    ).toEqual({ value: { users: [{ id: "u1" }] } });
  });

  test("an outer schema may ask for more than the DTOs it holds", () => {
    const Plain = tb(Type.Object({ id: Type.String() }));

    expect(() =>
      tb(Type.Object({ users: Type.Array(Plain) }), { clean: true }),
    ).not.toThrow();
  });

  test("a DTO wrapped again takes the options it is given, as before", () => {
    expect(() => tb(PublicUser, { issues: "summary" })).not.toThrow();
  });

  test("a DTO in the definitions of a recursive schema is found", () => {
    expect(() =>
      tb(Type.Cyclic({ U: PublicUser, L: Type.Array(Type.Ref("U")) }, "L")),
    ).toThrow(/clean/);
  });

  test("a DTO met twice is looked at once, and passes", () => {
    const Plain = tb(Type.Object({ id: Type.String() }));

    expect(() =>
      tb(
        Type.Object({
          owner: Plain,
          author: Plain,
          readers: Type.Array(Plain),
        }),
      ),
    ).not.toThrow();
  });

  test("a schema derived from a DTO is a schema of its own", () => {
    // Type.Pick rebuilds the object: nothing of PublicUser's is left in it,
    // its options included. This is the limit of the check, and it is said
    // in the documentation of tb().
    expect(() =>
      tb(Type.Object({ user: Type.Pick(PublicUser, ["id"]) })),
    ).not.toThrow();
  });
});
