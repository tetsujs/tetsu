/**
 * Scratch databases: created empty on the server of a client, connected
 * to, and dropped, whoever is still on them.
 *
 * @module
 */

import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { SQL } from "bun";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import { createScratch, scratchName, urlOf } from "./scratch.ts";

setDefaultTimeout(DATABASE_MS);

afterAll(async () => {
  await sql.close();
});

const { url } = testDatabase();
const sql = new SQL(url);

/** Whether a database of that name is on the server. */
async function exists(name: string): Promise<boolean> {
  const [row] =
    await sql`select count(*)::int as n from pg_database where datname = ${name}`;

  return row.n === 1;
}

/**
 * Closes a client whose connection the server cut, waiting a second at
 * most: Bun's `close()` of such a client now and then never settles.
 */
async function closeCut(client: SQL): Promise<void> {
  await Promise.race([client.close({ timeout: 0 }), Bun.sleep(1000)]);
}

describe("the URL of another database", () => {
  test("keeps the user, the server and the parameters, and names that database", () => {
    expect(
      urlOf(
        "postgres://user:pass@db.example:6543/app?sslmode=verify-full&options=-c%20search_path%3Dapp",
        "tetsu_sql_x",
      ),
    ).toBe(
      "postgres://user:pass@db.example:6543/tetsu_sql_x?sslmode=verify-full&options=-c%20search_path%3Dapp",
    );
  });
});

describe("a scratch database", () => {
  test("is created empty, named tetsu_sql_ and a UUIDv7, with a client of it", async () => {
    const scratch = await createScratch(url);

    try {
      const [row] = await scratch.sql`
        select current_database() as name,
               (select count(*)::int from pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public') as relations`;

      expect(scratch.name).toMatch(/^tetsu_sql_[0-9a-f]{12}7[0-9a-f]{19}$/);
      expect(row).toEqual({ name: scratch.name, relations: 0 });
    } finally {
      await scratch.drop();
    }

    expect(await exists(scratch.name)).toBe(false);
  });

  test("is dropped though a connection is still open on it", async () => {
    const scratch = await createScratch(url);
    const other = new SQL(urlOf(url, scratch.name));

    try {
      await other`select 1`;
      await scratch.drop();

      expect(await exists(scratch.name)).toBe(false);
    } finally {
      await closeCut(other);
    }
  });

  test("needs a user who may create databases, and says so", async () => {
    const role = `tetsu_sql_role_${Bun.randomUUIDv7().replaceAll("-", "")}`;

    await sql.unsafe(`create role ${role} login nocreatedb password 'scratch'`);

    const limited = new URL(url);

    limited.username = role;
    limited.password = "scratch";

    try {
      await expect(createScratch(limited.href)).rejects.toThrow(
        "cannot create a scratch database, which takes the right to create databases: permission denied to create database",
      );
    } finally {
      await sql.unsafe(`drop role ${role}`);
    }
  });

  test("left behind by a run that was killed is dropped by the next, once an hour old", async () => {
    const hours = (count: number) =>
      (Date.now() - count * 60 * 60 * 1000).toString(16).padStart(12, "0");
    const old = `tetsu_sql_${hours(2)}7${"0".repeat(19)}`;
    const recent = `tetsu_sql_${hours(0.5)}7${"0".repeat(19)}`;

    await sql.unsafe(`create database ${old}`);
    await sql.unsafe(`create database ${recent}`);

    try {
      const scratch = await createScratch(url);

      await scratch.drop();

      expect(await exists(old)).toBe(false);
      expect(await exists(recent)).toBe(true);
    } finally {
      await sql.unsafe(`drop database if exists ${old}`);
      await sql.unsafe(`drop database if exists ${recent}`);
    }
  });

  test("left behind but still in use is kept, however old its name", async () => {
    const old = `tetsu_sql_${(Date.now() - 2 * 60 * 60 * 1000).toString(16).padStart(12, "0")}7${"1".repeat(19)}`;

    await sql.unsafe(`create database ${old}`);

    const user = new SQL(urlOf(url, old));

    try {
      await user`select 1`;

      const scratch = await createScratch(url);

      await scratch.drop();

      expect(await exists(old)).toBe(true);
    } finally {
      await user.close();
      await sql.unsafe(`drop database if exists ${old} with (force)`);
    }
  });

  test("is judged old by the server's clock, not by a clock a test moved", async () => {
    const fresh = scratchName();

    await sql.unsafe(`create database ${fresh}`);
    setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));

    try {
      const scratch = await createScratch(url);

      await scratch.drop();

      expect(await exists(fresh)).toBe(true);
    } finally {
      setSystemTime();
      await sql.unsafe(`drop database if exists ${fresh}`);
    }
  });

  test("on a server that cannot be reached fails with the client's own error", async () => {
    await expect(
      createScratch("postgres://postgres@127.0.0.1:1/nowhere"),
    ).rejects.toMatchObject({ code: "ERR_POSTGRES_CONNECTION_REFUSED" });
  });

  test("is the database its client reaches, whatever PGDATABASE says", async () => {
    process.env.PGDATABASE = "postgres";

    try {
      const scratch = await createScratch(url);

      try {
        const [row] = await scratch.sql`select current_database() as name`;

        expect(row.name).toBe(scratch.name);
      } finally {
        await scratch.drop();
      }
    } finally {
      delete process.env.PGDATABASE;
    }
  });

  test("of a name that is not a scratch database's is refused, before anything is made", async () => {
    await expect(createScratch(url, "app; drop database app")).rejects.toThrow(
      new TypeError(
        "app; drop database app is not the name of a scratch database",
      ),
    );
  });

  test("has a name of its own each time", async () => {
    const first = await createScratch(url);
    const second = await createScratch(url);

    try {
      expect(first.name).not.toBe(second.name);
    } finally {
      await first.drop();
      await second.drop();
    }
  });
});
