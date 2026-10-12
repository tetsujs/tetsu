/**
 * Migration files: how they are named, read and created.
 *
 * A migration is `YYYYMMDDHHMMSS_name.sql`: the UTC time it was made, then
 * a name in lowercase letters, digits and underscores. Timestamps of one
 * length sort as strings in the order they were made, so files are ordered
 * by their names compared as plain strings — never in SQL, where the
 * collation decides how an underscore compares.
 *
 * @module
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MigrationError } from "./errors.ts";

/** A migration file, read and ready to run. */
export interface MigrationFile {
  /** The file's name, `YYYYMMDDHHMMSS_name.sql`. */
  readonly name: string;

  /**
   * Its SQL, with `\n` line ends. Bun drops a byte order mark when it
   * reads the file.
   */
  readonly text: string;

  /** The SHA-256 of {@link text}, in hex: what the journal compares. */
  readonly checksum: string;

  /** Whether it runs in a transaction: not when its first line is `-- no-transaction`. */
  readonly transaction: boolean;
}

/** What the name of a migration file looks like. */
const FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;

/** What the name part of a new migration may hold. */
const NAME = /^[a-z0-9_]+$/;

/** The line that makes a migration run outside a transaction. */
const NO_TRANSACTION = "-- no-transaction";

/** How a misnamed migration is told what its name should look like. */
const NAMING =
  "a migration is named YYYYMMDDHHMMSS_name.sql, with the UTC time it was made and a name in lowercase letters, digits and underscores";

/** Whether `digits` (fourteen of them) are a real UTC date and time. */
function isTime(digits: string): boolean {
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  const time = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return (
    time.getUTCFullYear() === year &&
    time.getUTCMonth() === month - 1 &&
    time.getUTCDate() === day &&
    time.getUTCHours() === hour &&
    time.getUTCMinutes() === minute &&
    time.getUTCSeconds() === second
  );
}

/** Whether a file name is a migration's: the pattern, and a real time. */
export function isMigrationName(file: string): boolean {
  const time = FILE.exec(file)?.[1];

  return time !== undefined && isTime(time);
}

/** The SHA-256 of a text, in hex. */
export function checksum(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Whether a migration holds nothing to run: only blank lines and comments.
 * A comment-only file is what a new migration starts as, and applying it
 * would record it, and refuse it as changed once it is written.
 */
export function isEmpty(text: string): boolean {
  return (
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("")
      .trim() === ""
  );
}

/**
 * Reads the migrations of a directory, in the order they run. Every `.sql`
 * file there must be named as a migration; other files are not read.
 */
export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[];

  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    throw new MigrationError("directory", `${dir} is not a directory`, {
      cause: error,
    });
  }

  const files: MigrationFile[] = [];

  for (const name of entries
    .filter((entry) => /\.sql$/i.test(entry))
    .toSorted()) {
    if (!isMigrationName(name)) {
      throw new MigrationError("name", `${name}: ${NAMING}`, {
        migration: name,
      });
    }

    const text = (await Bun.file(join(dir, name)).text()).replaceAll(
      "\r\n",
      "\n",
    );

    files.push({
      name,
      text,
      checksum: checksum(text),
      transaction: text.split("\n", 1)[0]?.trim() !== NO_TRANSACTION,
    });
  }

  return files;
}

/** Where a new migration goes, and what it is called. */
export interface CreateMigrationOptions {
  /** The migrations directory, from the working directory; created if absent. */
  readonly dir: string;

  /** The name after the timestamp: lowercase letters, digits and underscores. */
  readonly name: string;
}

/**
 * Creates an empty migration named with the current UTC time, and returns
 * its path. An existing file of the same name is refused, not overwritten.
 *
 * @example
 * ```ts
 * import { createMigration } from "@tetsujs/sql/generate";
 *
 * await createMigration({ dir: "./migrations", name: "add_orders" });
 * // "migrations/20261012153000_add_orders.sql"
 * ```
 */
export async function createMigration(
  options: CreateMigrationOptions,
): Promise<string> {
  const { dir, name } = options;

  if (!NAME.test(name)) {
    throw new MigrationError(
      "name",
      `"${name}" cannot name a migration: ${NAMING}`,
    );
  }

  const time = new Date().toISOString().replaceAll(/[-:T]/g, "").slice(0, 14);
  const file = `${time}_${name}.sql`;
  const path = join(dir, file);

  await mkdir(dir, { recursive: true });

  try {
    await writeFile(path, "", { flag: "wx" });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      throw error;
    }

    throw new MigrationError("name", `${path} exists already`, {
      migration: file,
      cause: error,
    });
  }

  return path;
}
