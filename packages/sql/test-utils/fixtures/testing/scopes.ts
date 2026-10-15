/**
 * A test file of its own for `testing.test.ts`, run in a child `bun test`:
 * each `describe` has a database of its own, which the other's tests do not
 * see.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { testDatabase } from "../../../src/testing.ts";
import { schema } from "../schema/db.generated.ts";

const dir = join(import.meta.dir, "../schema/migrations");

describe("the first", () => {
  const { db, name } = testDatabase(schema, {
    url: Bun.env["DATABASE_URL"],
    dir,
  });

  console.log(`database: ${name}`);

  test("writes a booking", async () => {
    await db
      .insertInto("bookings")
      .values({ id: 1, during: "[2026-10-01,2026-10-02)" })
      .execute();
  });
});

describe("the second", () => {
  const { db, name } = testDatabase(schema, {
    url: Bun.env["DATABASE_URL"],
    dir,
  });

  console.log(`database: ${name}`);

  test("does not see it", async () => {
    expect(await db.selectFrom("bookings").select("id").execute()).toEqual([]);
  });
});
