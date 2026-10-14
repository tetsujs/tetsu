/**
 * The `tetsu-sql` command, run as a `package.json` script runs it: in a
 * process of its own, with what it prints and the code it exits with.
 *
 * @module
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";

const cli = join(import.meta.dir, "cli.ts");
const root = join(import.meta.dir, "../../..");
const fixtures = join(import.meta.dir, "../test-utils/fixtures/schema");
const golden = await Bun.file(join(fixtures, "db.generated.ts")).text();
const goldenQueries = await Bun.file(
  join(fixtures, "queries.generated.ts"),
).text();
const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-cli-"));
setDefaultTimeout(DATABASE_MS);

const { url, sql } = testDatabase();

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** What a run of the command printed, and how it ended. */
interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the command with these arguments, in `cwd`, with this environment. */
function run(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Run {
  const { DATABASE_URL: _, ...env } = Bun.env;
  const result = Bun.spawnSync(["bun", cli, ...args], {
    cwd: options.cwd ?? scratch,
    env: { ...env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** A directory of its own, empty. */
function directory(): Promise<string> {
  return mkdtemp(join(scratch, "dir-"));
}

/** What a run printed, with each duration as `N`: how long a step takes varies. */
function timeless(stdout: string): string {
  return stdout.replaceAll(/ in \d+ ms$/gm, " in N ms");
}

/** The JSON lines a run printed, each parsed. */
function lines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("migrations:new", () => {
  test("creates an empty migration named with the current UTC time, and says where", async () => {
    const dir = await directory();
    const result = run(["migrations:new", "add_orders", "--dir", dir]);
    const [file] = await readdir(dir);

    expect(result.exitCode).toBe(0);
    expect(file).toMatch(/^\d{14}_add_orders\.sql$/);
    expect(result.stdout).toBe(`created ${join(dir, file ?? "")}\n`);
    expect(await Bun.file(join(dir, file ?? "")).text()).toBe("");
  });

  test("puts it in ./migrations when no --dir is given", async () => {
    const cwd = await directory();
    const result = run(["migrations:new", "first"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(await readdir(join(cwd, "migrations"))).toHaveLength(1);
  });

  test("refuses a name that cannot name a migration", async () => {
    const dir = await directory();
    const result = run(["migrations:new", "Add-Orders", "--dir", dir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith(
      'error: "Add-Orders" cannot name a migration',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  test("needs exactly one name", () => {
    for (const args of [["migrations:new"], ["migrations:new", "a", "b"]]) {
      const result = run(args);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toStartWith("migrations:new takes one name");
      expect(result.stderr).toContain("Usage: tetsu-sql");
    }
  });
});

describe("migrations:run", () => {
  test("applies the pending migrations and names them, then finds nothing to apply", async () => {
    const cwd = await directory();

    await mkdir(join(cwd, "migrations"));
    await Bun.write(
      join(cwd, "migrations", "20261010120000_first.sql"),
      "create table cli_first (x int);",
    );
    await Bun.write(
      join(cwd, "migrations", "20261011120000_second.sql"),
      "create table cli_second (x int);",
    );

    const applied = run(["migrations:run", "--url", url], { cwd });

    expect({ ...applied, stdout: timeless(applied.stdout) }).toEqual({
      exitCode: 0,
      stdout: [
        "applying 20261010120000_first.sql",
        "applied 20261010120000_first.sql in N ms",
        "applying 20261011120000_second.sql",
        "applied 20261011120000_second.sql in N ms",
        "",
      ].join("\n"),
      stderr: "",
    });

    const again = run(["migrations:run"], {
      cwd,
      env: { DATABASE_URL: url },
    });

    expect(again).toEqual({
      exitCode: 0,
      stdout: "nothing to apply\n",
      stderr: "",
    });
  });

  test("migrates the database its URL names, whatever PGDATABASE says", async () => {
    const cwd = await directory();
    const elsewhere = new URL(url);

    elsewhere.pathname = "/postgres";

    const other = new SQL(elsewhere.href);

    await mkdir(join(cwd, "migrations"));
    await Bun.write(
      join(cwd, "migrations", "20261010120000_first.sql"),
      "create table cli_pgdatabase (x int);",
    );

    try {
      const applied = run(
        ["migrations:run", "--url", url, "--table", "pgdatabase_journal"],
        { cwd, env: { PGDATABASE: "postgres" } },
      );
      const [here] =
        await sql`select to_regclass('cli_pgdatabase') is not null as found`;
      const [there] =
        await other`select to_regclass('cli_pgdatabase') is not null as found`;

      expect(applied.exitCode).toBe(0);
      expect({ here: here.found, there: there.found }).toEqual({
        here: true,
        there: false,
      });
    } finally {
      await other.unsafe(
        "drop table if exists cli_pgdatabase, pgdatabase_journal",
      );
      await other.close();
    }
  });

  test("passes --table and --lock-timeout-ms on", async () => {
    const dir = await directory();

    await Bun.write(
      join(dir, "20261010120000_first.sql"),
      "create table cli_named (x int);",
    );

    const result = run([
      "migrations:run",
      "--dir",
      dir,
      "--url",
      url,
      "--table",
      "cli_journal",
      "--lock-timeout-ms",
      "100",
    ]);

    const journal: { name: string }[] = await sql`select name from cli_journal`;

    expect(result.exitCode).toBe(0);
    expect(journal).toEqual([{ name: "20261010120000_first.sql" }]);

    const outOfRange = run([
      "migrations:run",
      "--dir",
      dir,
      "--url",
      url,
      "--table",
      "cli_journal",
      "--lock-timeout-ms",
      "3000000000",
    ]);

    expect(outOfRange.exitCode).toBe(1);
    expect(outOfRange.stderr).toStartWith("error: lockTimeoutMs must be");
  });

  test.each([["soon"], [""], ["1.5"], ["-1"]])(
    "refuses --lock-timeout-ms=%j, with the usage",
    async (value) => {
      const result = run([
        "migrations:run",
        "--dir",
        await directory(),
        "--url",
        url,
        `--lock-timeout-ms=${value}`,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toStartWith(
        `--lock-timeout-ms takes a whole number of milliseconds, not "${value}"`,
      );
      expect(result.stderr).toContain("Usage: tetsu-sql");
    },
  );

  test("says each step as it takes it, then what failed, and exits with 1", async () => {
    const dir = await directory();

    await Bun.write(
      join(dir, "20261010120000_good.sql"),
      "create table cli_good (x int);",
    );
    await Bun.write(join(dir, "20261011120000_broken.sql"), "select 1 / 0;");

    const result = run([
      "migrations:run",
      "--dir",
      dir,
      "--url",
      url,
      "--table",
      "cli_broken",
    ]);

    expect({ ...result, stdout: timeless(result.stdout) }).toEqual({
      exitCode: 1,
      stdout: [
        "applying 20261010120000_good.sql",
        "applied 20261010120000_good.sql in N ms",
        "applying 20261011120000_broken.sql",
        "",
      ].join("\n"),
      stderr: "error: 20261011120000_broken.sql failed: division by zero\n",
    });
  });

  test("says when the database is ahead of the files, as after a rollback", async () => {
    const dir = await directory();
    const flags = ["--dir", dir, "--url", url, "--table", "cli_ahead"];

    await Bun.write(
      join(dir, "20261010120000_first.sql"),
      "create table cli_kept (x int);",
    );
    await Bun.write(
      join(dir, "20261011120000_second.sql"),
      "create table cli_rolled_back (x int);",
    );

    expect(run(["migrations:run", ...flags]).exitCode).toBe(0);

    await rm(join(dir, "20261011120000_second.sql"));

    expect(run(["migrations:run", ...flags])).toEqual({
      exitCode: 0,
      stdout:
        "20261011120000_second.sql is applied, and newer than every file here\nnothing to apply\n",
      stderr: "",
    });
  });

  test("says when it waits for another run, then goes on", async () => {
    const dir = await directory();

    await Bun.write(
      join(dir, "20261010120000_first.sql"),
      "create table cli_waited (x int);",
    );

    const holder = await sql.reserve();
    const { DATABASE_URL: _, ...env } = Bun.env;
    const child = Bun.spawn(
      [
        "bun",
        cli,
        "migrations:run",
        ...["--dir", dir, "--url", url, "--table", "cli_waiting"],
      ],
      { cwd: scratch, env, stdout: "pipe", stderr: "pipe" },
    );

    try {
      await holder`select pg_advisory_lock(1953722732, hashtext('public.cli_waiting'))`;

      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";

      while (!stdout.includes("\n")) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        stdout += decoder.decode(chunk.value);
      }

      expect(stdout).toBe("waiting for another migration run to finish\n");

      await holder`select pg_advisory_unlock(1953722732, hashtext('public.cli_waiting'))`;

      for (let chunk = await reader.read(); !chunk.done; ) {
        stdout += decoder.decode(chunk.value);
        chunk = await reader.read();
      }

      expect(await child.exited).toBe(0);
      expect(timeless(stdout)).toBe(
        [
          "waiting for another migration run to finish",
          "applying 20261010120000_first.sql",
          "applied 20261010120000_first.sql in N ms",
          "",
        ].join("\n"),
      );
    } finally {
      child.kill();
      await holder`select pg_advisory_unlock_all()`;
      holder.release();
    }
  });

  test("needs a database", async () => {
    const result = run(["migrations:run", "--dir", await directory()]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("migrations:run needs a database");
  });

  test("needs a Postgres URL, and opens no other kind", async () => {
    const cwd = await directory();
    const result = run(["migrations:run", "--url", "sqlite://cli.db"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith(
      "migrations:run needs a postgres:// or postgresql:// URL",
    );
    expect(await readdir(cwd)).toEqual([]);
  });

  test("takes no names", async () => {
    const result = run(["migrations:run", "db/migrations", "--url", url]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("migrations:run takes no names");
  });

  test("says what the server answered, as it said it", async () => {
    const missing = new URL(url);

    missing.pathname = "/tetsu_sql_no_such_database";

    const result = run([
      "migrations:run",
      "--dir",
      await directory(),
      "--url",
      missing.href,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: database "tetsu_sql_no_such_database" does not exist\n',
    );
  });

  test("says in a line that the database cannot be reached", async () => {
    const result = run([
      "migrations:run",
      "--dir",
      await directory(),
      "--url",
      "postgres://postgres@127.0.0.1:1/nowhere",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("error: ");
    expect(result.stderr).toEndWith(" (ERR_POSTGRES_CONNECTION_REFUSED)\n");
    expect(result.stderr.split("\n")).toHaveLength(2);
  });
});

describe("migrations:baseline", () => {
  test("records the migrations up to the one named as applied, and says so; a run then applies the rest", async () => {
    const dir = await directory();
    const flags = ["--dir", dir, "--url", url, "--table", "cli_baseline"];

    await Bun.write(
      join(dir, "20261010120000_first.sql"),
      "create table cli_built (x int);",
    );
    await Bun.write(
      join(dir, "20261011120000_second.sql"),
      "create table cli_after (x int);",
    );
    await sql`create table cli_built (x int)`;

    expect(
      run(["migrations:baseline", "20261010120000_first", ...flags]),
    ).toEqual({
      exitCode: 0,
      stdout: "recorded 20261010120000_first.sql as applied\n",
      stderr: "",
    });

    const applied = run(["migrations:run", ...flags]);

    expect({ ...applied, stdout: timeless(applied.stdout) }).toEqual({
      exitCode: 0,
      stdout: [
        "applying 20261011120000_second.sql",
        "applied 20261011120000_second.sql in N ms",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("refuses a journal that records migrations already, and exits with 1", async () => {
    const dir = await directory();
    const flags = ["--dir", dir, "--url", url, "--table", "cli_recorded"];

    await Bun.write(join(dir, "20261010120000_first.sql"), "select 1;");

    expect(run(["migrations:run", ...flags]).exitCode).toBe(0);
    expect(
      run(["migrations:baseline", "20261010120000_first.sql", ...flags]),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "error: public.cli_recorded records migrations already: a baseline is only for a journal that records none\n",
    });
  });

  test("says to take a baseline, into the run's journal, when the first migration finds what it creates there", async () => {
    const cwd = await directory();

    await mkdir(join(cwd, "migrations"));
    await Bun.write(
      join(cwd, "migrations", "20261010120000_first.sql"),
      "create table cli_hinted (x int);",
    );
    await sql`create table cli_hinted (x int)`;

    const result = run(
      ["migrations:run", "--url", url, "--table", "cli_hinted_journal"],
      { cwd },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'error: 20261010120000_first.sql failed: relation "cli_hinted" already exists. If the database was built before its migrations, record the ones it has instead of running them: tetsu-sql migrations:baseline <the last one it has> --table cli_hinted_journal\n',
    );
  });

  test("needs exactly one migration, before it needs a database", () => {
    for (const args of [
      ["migrations:baseline"],
      ["migrations:baseline", "a", "b"],
    ]) {
      const result = run(args);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toStartWith(
        "migrations:baseline takes one migration: the last one the database has",
      );
      expect(result.stderr).toContain("Usage: tetsu-sql");
    }
  });

  test("needs a database", async () => {
    const result = run(["migrations:baseline", "20261010120000_first"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith("migrations:baseline needs a database");
  });
});

describe("--json", () => {
  test("prints each step as a JSON line, with its time and level, and the result at the end", async () => {
    const dir = await directory();

    await Bun.write(
      join(dir, "20261010120000_first.sql"),
      "create table cli_json_a (x int);",
    );
    await Bun.write(
      join(dir, "20261011120000_second.sql"),
      "create table cli_json_b (x int);",
    );

    const result = run([
      "migrations:run",
      "--json",
      ...["--dir", dir, "--url", url, "--table", "cli_json"],
    ]);
    const printed = lines(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(printed).toEqual([
      {
        time: expect.any(String),
        level: "info",
        event: "applying",
        migration: "20261010120000_first.sql",
      },
      {
        time: expect.any(String),
        level: "info",
        event: "applied",
        migration: "20261010120000_first.sql",
        durationMs: expect.any(Number),
      },
      {
        time: expect.any(String),
        level: "info",
        event: "applying",
        migration: "20261011120000_second.sql",
      },
      {
        time: expect.any(String),
        level: "info",
        event: "applied",
        migration: "20261011120000_second.sql",
        durationMs: expect.any(Number),
      },
      {
        time: expect.any(String),
        level: "info",
        event: "done",
        applied: ["20261010120000_first.sql", "20261011120000_second.sql"],
        ahead: [],
      },
    ]);
    expect(Object.keys(printed[0] ?? {})).toEqual([
      "time",
      "level",
      "event",
      "migration",
    ]);

    for (const line of printed) {
      expect(line.time).toBe(new Date(String(line.time)).toISOString());
    }
  });

  test("prints a failure as a JSON line too, on stdout, and nothing on stderr", async () => {
    const dir = await directory();

    await Bun.write(join(dir, "20261011120000_broken.sql"), "select 1 / 0;");

    const result = run([
      "migrations:run",
      "--json",
      ...["--dir", dir, "--url", url, "--table", "cli_json_broken"],
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(lines(result.stdout).at(-1)).toEqual({
      time: expect.any(String),
      level: "error",
      event: "error",
      message: "20261011120000_broken.sql failed: division by zero",
      reason: "failed",
      migration: "20261011120000_broken.sql",
    });
  });

  test("warns that the database is ahead of the files", async () => {
    const dir = await directory();
    const flags = ["--dir", dir, "--url", url, "--table", "cli_json_ahead"];

    await Bun.write(join(dir, "20261010120000_first.sql"), "select 1;");
    await Bun.write(join(dir, "20261011120000_second.sql"), "select 2;");

    expect(run(["migrations:run", ...flags]).exitCode).toBe(0);

    await rm(join(dir, "20261011120000_second.sql"));

    expect(lines(run(["migrations:run", "--json", ...flags]).stdout)).toEqual([
      {
        time: expect.any(String),
        level: "warn",
        event: "ahead",
        migration: "20261011120000_second.sql",
      },
      {
        time: expect.any(String),
        level: "info",
        event: "done",
        applied: [],
        ahead: ["20261011120000_second.sql"],
      },
    ]);
  });

  test("prints each migration a baseline records as a JSON line, and its refusal", async () => {
    const dir = await directory();
    const flags = ["--json", "--dir", dir, "--url", url];

    await Bun.write(join(dir, "20261010120000_first.sql"), "select 1;");
    await Bun.write(join(dir, "20261011120000_second.sql"), "select 2;");

    const baseline = [
      "migrations:baseline",
      "20261011120000_second",
      ...flags,
      ...["--table", "cli_json_baseline"],
    ];

    expect(lines(run(baseline).stdout)).toEqual([
      {
        time: expect.any(String),
        level: "info",
        event: "recorded",
        migration: "20261010120000_first.sql",
      },
      {
        time: expect.any(String),
        level: "info",
        event: "recorded",
        migration: "20261011120000_second.sql",
      },
    ]);
    expect(lines(run(baseline).stdout)).toEqual([
      {
        time: expect.any(String),
        level: "error",
        event: "error",
        message:
          "public.cli_json_baseline records migrations already: a baseline is only for a journal that records none",
        reason: "recorded",
      },
    ]);
  });

  test("names Bun's code for a database it cannot reach", async () => {
    const result = run([
      "migrations:run",
      "--json",
      ...["--dir", await directory()],
      ...["--url", "postgres://postgres@127.0.0.1:1/nowhere"],
    ]);

    expect(result.exitCode).toBe(1);
    expect(lines(result.stdout)).toEqual([
      {
        time: expect.any(String),
        level: "error",
        event: "error",
        message: expect.any(String),
        code: "ERR_POSTGRES_CONNECTION_REFUSED",
      },
    ]);
  });

  test("prints a created migration as a JSON line", async () => {
    const dir = await directory();
    const result = run([
      "migrations:new",
      "add_orders",
      "--json",
      "--dir",
      dir,
    ]);
    const [file] = await readdir(dir);

    expect(lines(result.stdout)).toEqual([
      {
        time: expect.any(String),
        level: "info",
        event: "created",
        path: join(dir, file ?? ""),
      },
    ]);
  });

  test("tells a mistake in the command line in words, on stderr", () => {
    const result = run(["migrations:run", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("migrations:run needs a database");
  });
});

describe("types:generate", () => {
  const migrations = join(fixtures, "migrations");

  test("writes the types to src/db.generated.ts, and says so", async () => {
    const cwd = await directory();
    const result = run(["types:generate", "--dir", migrations, "--url", url], {
      cwd,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "generated src/db.generated.ts\n",
      stderr: "",
    });
    expect(await Bun.file(join(cwd, "src/db.generated.ts")).text()).toBe(
      golden,
    );
  });

  test("with --int8 string, finds the file of int8 read as strings up to date, which the default would not be", async () => {
    const int8 = join(import.meta.dir, "../test-utils/fixtures/int8");
    const flags = [
      ...["--dir", join(int8, "migrations"), "--url", url],
      ...["--out", join(int8, "db.generated.ts")],
      ...["--queries", join(int8, "queries")],
      ...["--queries-out", join(int8, "queries.generated.ts")],
      "--check",
    ];

    expect(run(["types:generate", "--int8", "string", ...flags])).toEqual({
      exitCode: 0,
      stdout: [
        `${join(int8, "db.generated.ts")} is up to date`,
        `${join(int8, "queries.generated.ts")} is up to date`,
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(run(["types:generate", ...flags])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `error: ${join(int8, "db.generated.ts")} is out of date: run tetsu-sql types:generate\n`,
    });
  });

  test("writes them where --out says, over what is there", async () => {
    const out = join(await directory(), "types", "db.ts");

    await mkdir(join(out, ".."), { recursive: true });
    await Bun.write(out, "stale");

    const result = run([
      "types:generate",
      ...["--dir", migrations, "--url", url, "--out", out],
    ]);

    expect(result.stdout).toBe(`generated ${out}\n`);
    expect(await Bun.file(out).text()).toBe(golden);
  });

  test("with --check, finds a file that is up to date, whatever its layout, and writes nothing", async () => {
    const dir = await directory();
    const out = join(dir, "db.generated.ts");
    const flags = ["--dir", migrations, "--url", url, "--out", out];
    const biome = Bun.spawnSync(
      [
        join(root, "node_modules/.bin/biome"),
        "format",
        "--indent-style=tab",
        "--javascript-formatter-quote-style=single",
        "--semicolons=as-needed",
        "--stdin-file-path=packages/sql/db.generated.ts",
      ],
      { cwd: root, stdin: Buffer.from(golden), stdout: "pipe" },
    );
    const reformatted = biome.stdout.toString();

    await Bun.write(out, reformatted);

    expect(run(["types:generate", "--check", ...flags])).toEqual({
      exitCode: 0,
      stdout: `${out} is up to date\n`,
      stderr: "",
    });
    expect(await Bun.file(out).text()).toBe(reformatted);
  });

  test("with --check, refuses a file that is out of date, and one that is not there", async () => {
    const dir = await directory();
    const out = join(dir, "db.generated.ts");
    const flags = ["--dir", migrations, "--url", url, "--out", out];

    expect(run(["types:generate", "--check", ...flags])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `error: ${out} is not there: run tetsu-sql types:generate\n`,
    });

    await Bun.write(out, golden.replace("a_text: string;", "a_text: number;"));

    expect(run(["types:generate", "--check", ...flags])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `error: ${out} is out of date: run tetsu-sql types:generate\n`,
    });
  });

  test("prints JSON lines with --json", async () => {
    const out = join(await directory(), "db.generated.ts");
    const flags = ["--dir", migrations, "--url", url, "--out", out, "--json"];

    expect(lines(run(["types:generate", ...flags]).stdout)).toEqual([
      {
        time: expect.any(String),
        level: "info",
        event: "generated",
        path: out,
      },
    ]);
    expect(lines(run(["types:generate", "--check", ...flags]).stdout)).toEqual([
      { time: expect.any(String), level: "info", event: "checked", path: out },
    ]);
  });

  test("writes the functions of the files in ./queries beside the types, as --queries-out says", async () => {
    const cwd = await directory();

    await cp(join(fixtures, "queries"), join(cwd, "queries"), {
      recursive: true,
    });

    const flags = ["--dir", migrations, "--url", url];
    const files = ["--out", "db.generated.ts"];

    expect(
      run(
        [
          "types:generate",
          ...flags,
          ...files,
          ...["--queries-out", "queries.generated.ts"],
        ],
        { cwd },
      ),
    ).toEqual({
      exitCode: 0,
      stdout: "generated db.generated.ts\ngenerated queries.generated.ts\n",
      stderr: "",
    });
    expect(await Bun.file(join(cwd, "queries.generated.ts")).text()).toBe(
      goldenQueries,
    );
    expect(run(["types:generate", ...flags], { cwd })).toMatchObject({
      exitCode: 0,
      stdout:
        "generated src/db.generated.ts\ngenerated src/queries.generated.ts\n",
    });
    expect(
      await Bun.file(join(cwd, "src/queries.generated.ts")).text(),
    ).toContain('import type * as Database from "./db.generated.ts";');
  });

  test("with --check, checks the functions of the queries too", async () => {
    const cwd = await directory();

    await cp(join(fixtures, "queries"), join(cwd, "queries"), {
      recursive: true,
    });
    await Bun.write(join(cwd, "db.generated.ts"), golden);
    await Bun.write(join(cwd, "queries.generated.ts"), goldenQueries);

    const flags = [
      "types:generate",
      "--check",
      ...["--dir", migrations, "--url", url, "--out", "db.generated.ts"],
      ...["--queries-out", "queries.generated.ts"],
    ];

    expect(run(flags, { cwd })).toEqual({
      exitCode: 0,
      stdout:
        "db.generated.ts is up to date\nqueries.generated.ts is up to date\n",
      stderr: "",
    });

    await Bun.write(
      join(cwd, "queries.generated.ts"),
      goldenQueries.replace("  count: number;", "  count: bigint;"),
    );

    expect(run(flags, { cwd })).toEqual({
      exitCode: 1,
      stdout: "db.generated.ts is up to date\n",
      stderr:
        "error: queries.generated.ts is out of date: run tetsu-sql types:generate\n",
    });
  });

  test("says which query Postgres refused, where, and writes nothing", async () => {
    const cwd = await directory();

    await Bun.write(
      join(cwd, "queries/orders.sql"),
      "select id,\n  qqqqqq\nfrom orders",
    );

    expect(
      run(["types:generate", "--dir", migrations, "--url", url], { cwd }),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: 'error: queries/orders.sql:2:3: column "qqqqqq" does not exist\n',
    });
    expect(await Bun.file(join(cwd, "src/db.generated.ts")).exists()).toBe(
      false,
    );
  });

  test("refuses --queries-out with no query files to write the functions of", async () => {
    expect(
      run([
        "types:generate",
        ...["--dir", migrations, "--url", url, "--queries-out", "q.ts"],
      ]),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "error: queries is not a directory of query files\n",
    });
  });

  test("with --check, refuses a file of queries left behind by query files that are gone", async () => {
    const cwd = await directory();

    await Bun.write(join(cwd, "src/db.generated.ts"), golden);
    await Bun.write(join(cwd, "src/queries.generated.ts"), goldenQueries);

    expect(
      run(["types:generate", "--check", "--dir", migrations, "--url", url], {
        cwd,
      }),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "error: src/queries.generated.ts is out of date: there are no query files, in queries, for it to hold\n",
    });
  });

  test("refuses --queries that names no directory", async () => {
    expect(
      run([
        "types:generate",
        ...["--dir", migrations, "--url", url, "--queries", "nowhere"],
      ]),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "error: nowhere is not a directory of query files\n",
    });
  });

  test("says which migration failed, and writes nothing", async () => {
    const dir = await directory();
    const out = join(dir, "db.generated.ts");

    await Bun.write(join(dir, "20261010120000_broken.sql"), "select 1 / 0;");

    const result = run([
      "types:generate",
      "--dir",
      dir,
      "--url",
      url,
      "--out",
      out,
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "error: 20261010120000_broken.sql failed: division by zero\n",
    });
    expect(await Bun.file(out).exists()).toBe(false);
  });
});

describe("the command line", () => {
  test("shows the usage with --help", () => {
    const result = run(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("Usage: tetsu-sql <command> [options]");
  });

  test.each([
    [[], "a command is needed"],
    [["migrations:up"], "unknown command migrations:up"],
    [["migrations:run", "--nope"], "Unknown option '--nope'"],
    [["migrations:run", "--check"], "migrations:run does not take --check"],
    [["migrations:run", "--out", "x.ts"], "migrations:run does not take --out"],
    [
      ["migrations:new", "a", "--url", "x"],
      "migrations:new does not take --url",
    ],
    [
      ["types:generate", "--lock-timeout-ms", "5"],
      "types:generate does not take --lock-timeout-ms",
    ],
    [["types:generate", "extra"], "types:generate takes no names"],
    [
      ["types:generate", "--out", "a.ts", "--queries-out", "./a.ts"],
      "--out and --queries-out name the same file",
    ],
    [
      ["migrations:run", "--queries", "q"],
      "migrations:run does not take --queries",
    ],
    [
      ["migrations:baseline", "a", "--lock-timeout-ms", "5"],
      "migrations:baseline does not take --lock-timeout-ms",
    ],
    [
      ["migrations:baseline", "a", "--check"],
      "migrations:baseline does not take --check",
    ],
    [
      ["types:generate", "--int8", "number"],
      '--int8 takes bigint or string, not "number"',
    ],
    [
      ["migrations:run", "--int8", "string"],
      "migrations:run does not take --int8",
    ],
  ])("refuses %j, with the usage", (args, message) => {
    const result = run(args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage: tetsu-sql");
  });
});
