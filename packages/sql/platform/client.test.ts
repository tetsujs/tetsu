/**
 * What a Bun.SQL client reaches, and what it offers: the database a URL
 * names gives way to `PGDATABASE`, which is why the package hands Bun the
 * URL's database apart from the URL, and a query cannot be described
 * without running it, which is why the generator speaks Postgres's
 * protocol itself.
 *
 * @module
 */

import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { testDatabase } from "../test-utils/database.ts";

afterAll(async () => {
  await Promise.all(opened.map((client) => client.close()));
});

const { sql, url } = testDatabase();
const opened: SQL[] = [];

test("PGDATABASE wins over the database a URL names, still oven-sh/bun#45276", async () => {
  process.env.PGDATABASE = "postgres";

  try {
    const client = new SQL(url);

    opened.push(client);

    const [row] = await client`select current_database() as database`;

    expect(row.database).toBe("postgres");
  } finally {
    delete process.env.PGDATABASE;
  }
});

test("a query has no describe(), still oven-sh/bun#45277", () => {
  expect("describe" in sql`select 1`).toBe(false);
});
