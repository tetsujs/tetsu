/**
 * A test file of its own for `database.test.ts`, run in a child `bun
 * test`: its test times out while a query is still running, so the parent
 * can check the database is dropped all the same.
 *
 * @module
 */

import { test } from "bun:test";
import { testDatabase } from "../database.ts";

const { name, sql } = testDatabase();

console.log(`database: ${name}`);

test("times out while its query runs", async () => {
  await sql`select pg_sleep(30)`;
}, 250);
