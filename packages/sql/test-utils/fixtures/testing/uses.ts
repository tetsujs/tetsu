/**
 * A test file of its own for `testing.test.ts`, run in a child `bun test`:
 * it prints the name of its database as it loads, and that it is built in
 * a `beforeAll` of its own, and reads a table the migrations made, so the
 * parent can check the database was built, or never, and is gone once the
 * file has ended.
 *
 * @module
 */

import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { testDatabase } from "../../../src/testing.ts";
import { schema } from "../schema/db.generated.ts";

const { db, name } = testDatabase(schema, {
  url: Bun.env["DATABASE_URL"],
  dir: join(import.meta.dir, "../schema/migrations"),
});

console.log(`database: ${name}`);

beforeAll(() => {
  console.log("built");
});

test("reads a table the migrations made", async () => {
  expect(await db.selectFrom("orders").select("id").execute()).toEqual([]);
});
