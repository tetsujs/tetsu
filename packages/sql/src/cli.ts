#!/usr/bin/env bun
/**
 * `tetsu-sql`: migrations from the command line, for `package.json`
 * scripts. Each command is one of the package's functions with its options
 * as flags, and the database is `--url` or `DATABASE_URL`.
 *
 * ```json
 * "scripts": {
 *   "db:new": "tetsu-sql migrations:new",
 *   "db:migrate": "tetsu-sql migrations:run"
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

import { parseArgs } from "node:util";
import { SQL } from "bun";
import { MigrationError } from "./errors.ts";
import type { MigrateResult, MigrationRecord } from "./migrate.ts";
import { migrate } from "./migrate.ts";
import { createMigration } from "./migration-files.ts";

const usage = `Usage: tetsu-sql <command> [options]

Commands:
  migrations:new <name>    Create an empty migration, named with the current UTC time
  migrations:run           Apply the pending migrations

Options:
  --dir <path>             The migrations directory (default: migrations)
  --url <url>              The database (default: the DATABASE_URL variable)
  --table <name>           The journal table (default: migrations)
  --lock-timeout-ms <ms>   How long a statement in a transaction may wait for a lock (default: 5000)
  --json                   Print each line as a JSON object, for a log collector
  -h, --help               Show this`;

/** A mistake in how the command was called, answered with the usage. */
class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * A line the command prints: a step of a run, a migration created, or the
 * end of a run, with its result.
 */
type Line =
  | MigrationRecord
  | { readonly event: "created"; readonly path: string }
  | ({ readonly event: "done" } & MigrateResult);

/** The flags and words of a command line; a flag it does not know is a mistake. */
function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        dir: { type: "string", default: "migrations" },
        url: { type: "string" },
        table: { type: "string" },
        "lock-timeout-ms": { type: "string" },
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

/** Whether a database URL is a Postgres one: `migrate` runs on nothing else. */
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

  if (command === "migrations:new") {
    const [name] = rest;

    if (name === undefined || rest.length > 1) {
      throw new UsageError("migrations:new takes one name, such as add_orders");
    }

    print({
      event: "created",
      path: await createMigration({ dir: values.dir, name }),
    });

    return 0;
  }

  if (command === "migrations:run") {
    const { DATABASE_URL } = Bun.env;
    const url = values.url ?? DATABASE_URL;
    const lockTimeout = values["lock-timeout-ms"];
    const lockTimeoutMs =
      lockTimeout === undefined ? undefined : milliseconds(lockTimeout);

    if (rest.length > 0) {
      throw new UsageError(
        "migrations:run takes no names: pass the directory as --dir",
      );
    }

    if (url === undefined || url === "") {
      throw new UsageError(
        "migrations:run needs a database: set DATABASE_URL, or pass --url",
      );
    }

    if (!isPostgres(url)) {
      throw new UsageError(
        "migrations:run needs a postgres:// or postgresql:// URL",
      );
    }

    const sql = new SQL(url);

    try {
      const result = await migrate(sql, {
        dir: values.dir,
        write: print,
        ...(values.table === undefined ? {} : { table: values.table }),
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
      });

      print({ event: "done", ...result });
    } finally {
      await sql.close();
    }

    return 0;
  }

  throw new UsageError(
    command === undefined
      ? "a command is needed"
      : `unknown command ${command}`,
  );
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
