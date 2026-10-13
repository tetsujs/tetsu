#!/usr/bin/env bun
/**
 * `tetsu-sql`: migrations and types from the command line, for
 * `package.json` scripts. Each command is one of the package's functions
 * with its options as flags, and the database is `--url` or
 * `DATABASE_URL`.
 *
 * ```json
 * "scripts": {
 *   "db:new": "tetsu-sql migrations:new",
 *   "db:migrate": "tetsu-sql migrations:run",
 *   "db:types": "tetsu-sql types:generate"
 * }
 * ```
 *
 * It prints a line for each step as the step is taken, and a failure on
 * stderr. With `--json`, each line is a JSON object with its time and
 * level, for a log collector, and a failure is one too, on stdout with the
 * rest, so that stdout holds the whole run. A mistake in the command line
 * itself is told in words on stderr either way.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { clientOf } from "./client.ts";
import { MigrationError } from "./errors.ts";
import { generate } from "./generate.ts";
import type { MigrateResult, MigrationRecord } from "./migrate.ts";
import { migrate } from "./migrate.ts";
import { createMigration } from "./migration-files.ts";
import { isSameCode } from "./same-code.ts";

const usage = `Usage: tetsu-sql <command> [options]

Commands:
  migrations:new <name>    Create an empty migration, named with the current UTC time
  migrations:run           Apply the pending migrations
  types:generate           Write the Kysely types of the database the migrations build,
                           on a scratch database of the server

Options:
  --dir <path>             The migrations directory (default: migrations)
  --url <url>              The database (default: the DATABASE_URL variable)
  --table <name>           The journal table (default: migrations)
  --lock-timeout-ms <ms>   How long a statement in a transaction may wait for a lock (default: 5000)
  --out <path>             Where the types go (default: src/db.generated.ts)
  --check                  Check that the types are up to date, and write nothing
  --json                   Print each line as a JSON object, for a log collector
  -h, --help               Show this`;

/** The migrations directory when no `--dir` is given. */
const DIR = "migrations";

/** Where the types go when no `--out` is given. */
const OUT = "src/db.generated.ts";

/** The flags each command takes, past `--json` and `--help`, which all do. */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  "migrations:new": ["dir"],
  "migrations:run": ["dir", "url", "table", "lock-timeout-ms"],
  "types:generate": ["dir", "url", "table", "out", "check"],
};

/** A mistake in how the command was called, answered with the usage. */
class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * A line the command prints: a step of a run, a migration created, the end
 * of a run with its result, or what became of the types.
 */
type Line =
  | MigrationRecord
  | { readonly event: "created"; readonly path: string }
  | ({ readonly event: "done" } & MigrateResult)
  | { readonly event: "generated"; readonly path: string }
  | { readonly event: "checked"; readonly path: string };

/** The flags and words of a command line; a flag it does not know is a mistake. */
function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        url: { type: "string" },
        table: { type: "string" },
        "lock-timeout-ms": { type: "string" },
        out: { type: "string" },
        check: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Whether a database URL is a Postgres one: the package runs on nothing else. */
function isPostgres(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;

  return protocol === "postgres:" || protocol === "postgresql:";
}

/** `--lock-timeout-ms` as a number: digits only, so an empty value is a mistake, not 0. */
function milliseconds(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(
      `--lock-timeout-ms takes a whole number of milliseconds, not "${value}"`,
    );
  }

  return Number(value);
}

/** The database a command connects to: `--url`, or `DATABASE_URL`. */
function databaseUrl(command: string, url: string | undefined): string {
  const { DATABASE_URL } = Bun.env;
  const found = url ?? DATABASE_URL;

  if (found === undefined || found === "") {
    throw new UsageError(
      `${command} needs a database: set DATABASE_URL, or pass --url`,
    );
  }

  if (!isPostgres(found)) {
    throw new UsageError(`${command} needs a postgres:// or postgresql:// URL`);
  }

  return found;
}

/** How a line reads to a person. The end of a run says something only when nothing was applied. */
function textOf(line: Line): string | undefined {
  switch (line.event) {
    case "waiting":
      return "waiting for another migration run to finish";
    case "ahead":
      return `${line.migration} is applied, and newer than every file here`;
    case "applying":
      return `applying ${line.migration}`;
    case "applied":
      return `applied ${line.migration} in ${Math.round(line.durationMs)} ms`;
    case "created":
      return `created ${line.path}`;
    case "done":
      return line.applied.length === 0 ? "nothing to apply" : undefined;
    case "generated":
      return `generated ${line.path}`;
    case "checked":
      return `${line.path} is up to date`;
  }
}

/** Prints fields as a JSON line, with the time and the level a log collector reads. */
function printJson(level: "info" | "warn" | "error", fields: object): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, ...fields }),
  );
}

/** How the command prints its lines: in words, or as JSON. */
function printer(json: boolean): (line: Line) => void {
  if (json) {
    return (line) => printJson(line.event === "ahead" ? "warn" : "info", line);
  }

  return (line) => {
    const text = textOf(line);

    if (text !== undefined) {
      console.log(text);
    }
  };
}

/** Runs one command and returns the exit code. */
async function main(
  { values, positionals }: ReturnType<typeof parse>,
  print: (line: Line) => void,
): Promise<number> {
  const [command, ...rest] = positionals;

  if (values.help === true) {
    console.log(usage);

    return 0;
  }

  if (command === undefined) {
    throw new UsageError("a command is needed");
  }

  const allowed = FLAGS[command];

  if (allowed === undefined) {
    throw new UsageError(`unknown command ${command}`);
  }

  for (const flag of Object.keys(values)) {
    if (flag !== "json" && !allowed.includes(flag)) {
      throw new UsageError(`${command} does not take --${flag}`);
    }
  }

  if (command !== "migrations:new" && rest.length > 0) {
    throw new UsageError(
      `${command} takes no names: pass the directory as --dir`,
    );
  }

  const dir = values.dir ?? DIR;

  if (command === "migrations:new") {
    const [name] = rest;

    if (name === undefined || rest.length > 1) {
      throw new UsageError("migrations:new takes one name, such as add_orders");
    }

    print({ event: "created", path: await createMigration({ dir, name }) });

    return 0;
  }

  const lockTimeout = values["lock-timeout-ms"];
  const lockTimeoutMs =
    lockTimeout === undefined ? undefined : milliseconds(lockTimeout);
  const url = databaseUrl(command, values.url);
  const table = values.table === undefined ? {} : { table: values.table };

  if (command === "migrations:run") {
    const sql = clientOf(url);

    try {
      const result = await migrate(sql, {
        dir,
        write: print,
        ...table,
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
      });

      print({ event: "done", ...result });

      return 0;
    } finally {
      await sql.close();
    }
  }

  const out = values.out ?? OUT;
  const source = await generate({ url, dir, ...table });

  if (values.check !== true) {
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, source);
    print({ event: "generated", path: out });

    return 0;
  }

  const file = Bun.file(out);

  if (!(await file.exists())) {
    throw new Error(`${out} is not there: run tetsu-sql types:generate`);
  }

  if (!isSameCode(await file.text(), source)) {
    throw new Error(`${out} is out of date: run tetsu-sql types:generate`);
  }

  print({ event: "checked", path: out });

  return 0;
}

/**
 * Bun's code for a client's error with no SQLSTATE, such as a refused
 * connection: its message says little more than "Failed to connect".
 */
function clientCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const { code, errno } = error as Error & { code?: unknown; errno?: unknown };

  return typeof code === "string" && errno === undefined ? code : undefined;
}

/** What a failure says, in words. */
function failureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = clientCode(error);

  return code === undefined
    ? `error: ${message}`
    : `error: ${message} (${code})`;
}

/** What a failure says, as JSON fields: its message, and what comes with it. */
function failureFields(error: unknown): object {
  const message = error instanceof Error ? error.message : String(error);
  const code = clientCode(error);

  if (error instanceof MigrationError) {
    return {
      event: "error",
      message,
      reason: error.reason,
      ...(error.migration === undefined ? {} : { migration: error.migration }),
    };
  }

  return { event: "error", message, ...(code === undefined ? {} : { code }) };
}

let json = false;

try {
  const args = parse(Bun.argv.slice(2));

  json = args.values.json === true;
  process.exitCode = await main(args, printer(json));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${usage}`);
  } else if (json) {
    printJson("error", failureFields(error));
  } else {
    console.error(failureLine(error));
  }

  process.exitCode = 1;
}
