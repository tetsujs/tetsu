/**
 * A test file of its own for `testing.test.ts`, run in a child `bun test`:
 * its first migration creates what every new database has, so the
 * migrations fail, saying nothing of a baseline, and its database is
 * dropped all the same.
 *
 * @module
 */

import { afterAll, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "../../../src/testing.ts";
import { schema } from "../schema/db.generated.ts";

const dir = await mkdtemp(join(tmpdir(), "tetsu-sql-duplicate-"));

await Bun.write(
  join(dir, "20261010120000_public.sql"),
  "create schema public;",
);

const { name } = testDatabase(schema, { url: Bun.env["DATABASE_URL"], dir });

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

console.log(`database: ${name}`);

test("never runs on migrations that fail", () => {});
