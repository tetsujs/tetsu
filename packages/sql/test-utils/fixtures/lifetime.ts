/**
 * A test file of its own for `database.test.ts`, run in a child `bun
 * test`: it prints the name of its database as it loads, so the parent can
 * check the database is gone once the file has ended — whether its test
 * ran or a `-t` filter skipped it.
 *
 * @module
 */

import { test } from "bun:test";
import { testDatabase } from "../database.ts";

const { name, sql } = testDatabase();

console.log(`database: ${name}`);

test("uses its database", async () => {
  await sql`select 1`;
});
