/**
 * A test file of its own for `testing.test.ts`, run in a child `bun test`:
 * its types were built from an older migration than the directory holds,
 * so its database is refused once built, and dropped all the same.
 *
 * @module
 */

import { test } from "bun:test";
import { join } from "node:path";
import { testDatabase } from "../../../src/testing.ts";
import { schema } from "../schema/db.generated.ts";

const { name } = testDatabase(
  {
    ...schema,
    migration: { name: "20261001120000_kinds.sql", checksum: "0" },
  },
  {
    url: Bun.env["DATABASE_URL"],
    dir: join(import.meta.dir, "../schema/migrations"),
  },
);

console.log(`database: ${name}`);

test("never runs against types older than its database", () => {});
