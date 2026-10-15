/**
 * A test file of its own for `testing.test.ts`, run in a child `bun test`:
 * its test leaves a transaction open, so the pool cannot close, and the
 * file fails once its database is dropped all the same.
 *
 * @module
 */

import { test } from "bun:test";
import { join } from "node:path";
import { testDatabase } from "../../../src/testing.ts";
import { schema } from "../schema/db.generated.ts";

const { db, name } = testDatabase(schema, {
  url: Bun.env["DATABASE_URL"],
  dir: join(import.meta.dir, "../schema/migrations"),
});

console.log(`database: ${name}`);

test("leaves a transaction open", async () => {
  await db.startTransaction().execute();
});
