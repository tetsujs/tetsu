/**
 * Migration files: the naming rule, what counts as empty, how a directory
 * is read, and how a new migration is created.
 *
 * @module
 */

import {
  afterAll,
  afterEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationError } from "./errors.ts";
import {
  checksum,
  createMigration,
  isEmpty,
  isMigrationName,
  readMigrations,
} from "./migration-files.ts";

const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-files-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A directory of its own holding these files. */
async function directory(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(scratch, "dir-"));

  for (const [name, text] of Object.entries(files)) {
    await Bun.write(join(dir, name), text);
  }

  return dir;
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<MigrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MigrationError) {
      return error;
    }

    throw error;
  }

  throw new Error("it did not reject");
}

describe("the name of a migration", () => {
  test.each([
    "20261012153000_add_orders.sql",
    "20240229000000_leap_day.sql",
    "20261231235959_x9.sql",
  ])("%s is one", (name) => {
    expect(isMigrationName(name)).toBe(true);
  });

  test.each([
    ["2026101215300_short.sql", "thirteen digits"],
    ["202610121530000_long.sql", "fifteen digits"],
    ["20261312153000_month.sql", "a thirteenth month"],
    ["20260230120000_day.sql", "February 30"],
    ["20230229120000_day.sql", "February 29 of a common year"],
    ["20261012240000_hour.sql", "hour 24"],
    ["20261012156000_minute.sql", "minute 60"],
    ["20261012153000_Add.sql", "an uppercase letter"],
    ["20261012153000_add-orders.sql", "a hyphen"],
    ["20261012153000_.sql", "no name"],
    ["20261012153000-add.sql", "a hyphen after the time"],
    ["20261012153000_add.SQL", "an uppercase extension"],
    ["1_add.sql", "a serial number"],
  ])("%s is not, with %s", (name) => {
    expect(isMigrationName(name)).toBe(false);
  });
});

describe("an empty migration", () => {
  test.each([
    ["", "nothing"],
    ["  \n\n", "blank lines"],
    ["-- no-transaction\n", "only the marker"],
    ["-- to do\n/* later\n   on */\n", "only comments"],
  ])("holds %j: %s", (text) => {
    expect(isEmpty(text)).toBe(true);
  });

  test.each([
    "select 1",
    "-- comment\ncreate table a (x int);",
    "/* c */ create table a (x int);",
  ])("%j is not empty", (text) => {
    expect(isEmpty(text)).toBe(false);
  });
});

describe("reading a directory", () => {
  test("lists the migrations in order, and reads only .sql files", async () => {
    const dir = await directory({
      "20261012153000_second.sql": "create table b (x int);",
      "20261010120000_first.sql": "create table a (x int);",
      "README.md": "not a migration",
    });

    await mkdir(join(dir, "20261011000000_folder.sql"));

    const files = await readMigrations(dir);

    expect(files.map((file) => file.name)).toEqual([
      "20261010120000_first.sql",
      "20261012153000_second.sql",
    ]);
    expect(files[0]?.text).toBe("create table a (x int);");
    expect(files[0]?.checksum).toBe(checksum("create table a (x int);"));
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses a .sql file named otherwise, with its name", async () => {
    const dir = await directory({
      "20261010120000_first.sql": "select 1",
      "2_second.SQL": "select 2",
    });
    const error = await rejection(readMigrations(dir));

    expect(error.reason).toBe("name");
    expect(error.migration).toBe("2_second.SQL");
    expect(error.message).toContain("YYYYMMDDHHMMSS_name.sql");
  });

  test("drops a byte order mark and CRLF line ends, so the checksum is the text's", async () => {
    const dir = await directory({
      "20261010120000_first.sql":
        "\uFEFFcreate table a (x int);\r\ncreate table b (x int);\r\n",
    });
    const [file] = await readMigrations(dir);
    const text = "create table a (x int);\ncreate table b (x int);\n";

    expect(file?.text).toBe(text);
    expect(file?.checksum).toBe(checksum(text));
  });

  test("refuses a file that is not UTF-8, with its name, where Bun would read its bytes as U+FFFD", async () => {
    const dir = await directory({ "20261010120000_first.sql": "select 1;" });

    await Bun.write(
      join(dir, "20261011120000_latin1.sql"),
      new Uint8Array([
        ...new TextEncoder().encode("insert into countries values ('C"),
        0xf4,
        ...new TextEncoder().encode("te d''Ivoire');"),
      ]),
    );

    const error = await rejection(readMigrations(dir));

    expect(error.reason).toBe("encoding");
    expect(error.migration).toBe("20261011120000_latin1.sql");
    expect(error.message).toBe(
      "20261011120000_latin1.sql is not UTF-8: save it as UTF-8",
    );
  });

  test("runs a migration outside a transaction only when its first line says so", async () => {
    const dir = await directory({
      "20261010120000_a.sql":
        "-- no-transaction\ncreate index concurrently i on t (x);",
      "20261010120001_b.sql": "\uFEFF-- no-transaction  \r\nselect 1;",
      "20261010120002_c.sql": "select 1;\n-- no-transaction\n",
      "20261010120003_d.sql": "-- No-Transaction\nselect 1;",
    });
    const files = await readMigrations(dir);

    expect(files.map((file) => file.transaction)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test("refuses a directory that is not there", async () => {
    const error = await rejection(readMigrations(join(scratch, "nowhere")));

    expect(error.reason).toBe("directory");
    expect(error.migration).toBeUndefined();
  });
});

describe("creating a migration", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("names it with the current UTC time and leaves it empty", async () => {
    setSystemTime(new Date("2026-10-12T15:30:07.900Z"));

    const dir = await directory({});
    const path = await createMigration({ dir, name: "add_orders" });

    expect(path).toBe(join(dir, "20261012153007_add_orders.sql"));
    expect(await Bun.file(path).text()).toBe("");
  });

  test("creates the directory when it is not there", async () => {
    const dir = join(scratch, "new", "migrations");
    const path = await createMigration({ dir, name: "first" });

    expect(await readdir(dir)).toEqual([path.slice(dir.length + 1)]);
  });

  test("adds it to a directory that holds migrations already", async () => {
    setSystemTime(new Date("2026-10-12T15:30:00Z"));

    const dir = await directory({
      "20261010120000_first.sql": "create table a (x int);",
    });

    await createMigration({ dir, name: "second" });

    expect((await readdir(dir)).toSorted()).toEqual([
      "20261010120000_first.sql",
      "20261012153000_second.sql",
    ]);
    expect(await Bun.file(join(dir, "20261010120000_first.sql")).text()).toBe(
      "create table a (x int);",
    );
  });

  test("passes on the error of a file where the directory should be, as it is", async () => {
    const dir = await directory({ migrations: "not a directory" });
    const error = await createMigration({
      dir: join(dir, "migrations"),
      name: "first",
    }).catch((failure: unknown) => failure);

    expect(error).not.toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: "EEXIST" });
  });

  test("refuses a file that exists, rather than overwrite it", async () => {
    setSystemTime(new Date("2026-10-12T15:30:00Z"));

    const dir = await directory({});
    const path = await createMigration({ dir, name: "add_orders" });

    await Bun.write(path, "create table orders (id int);");

    const error = await rejection(createMigration({ dir, name: "add_orders" }));

    expect(error.reason).toBe("name");
    expect(error.message).toContain("exists already");
    expect(await Bun.file(path).text()).toBe("create table orders (id int);");
  });

  test("passes on any other error as it is", async () => {
    const dir = await directory({});
    const error = await createMigration({ dir, name: "a".repeat(300) }).catch(
      (failure: unknown) => failure,
    );

    expect(error).not.toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: "ENAMETOOLONG" });
  });

  test.each([
    ["Add_orders", "an uppercase letter"],
    ["add-orders", "a hyphen"],
    ["", "nothing"],
    ["../outside", "a path"],
    ["add orders", "a space"],
  ])("refuses the name %j, with %s", async (name) => {
    const dir = await directory({});
    const error = await rejection(createMigration({ dir, name }));

    expect(error.reason).toBe("name");
    expect(await readdir(dir)).toEqual([]);
  });

  test("makes a name readMigrations accepts", async () => {
    const dir = await directory({});

    await createMigration({ dir, name: "a_1" });

    const [file] = await readMigrations(dir);

    expect(file?.name).toMatch(/^\d{14}_a_1\.sql$/);
  });
});
