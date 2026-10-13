/**
 * Scratch databases: an empty database of its own on a server, for as long
 * as the generator, or a test file, needs one.
 *
 * Each is created from `template0`, so that nothing an administrator put
 * in `template1` reaches it: what it holds is what the migrations build.
 * Its name, `tetsu_sql_` and a UUIDv7, carries the time it was made, and a
 * run that was killed before it dropped its database leaves one that the
 * next run on the server drops, once it is an hour old.
 *
 * @module
 */

import type { SQL } from "bun";
import { clientOf } from "./client.ts";

/** A database of its own, and a client of it. */
export interface Scratch {
  /** The database's name. */
  readonly name: string;

  /** A client of the database. */
  readonly sql: SQL;

  /** Closes the client, then drops the database, whoever is still on it. */
  drop(): Promise<void>;
}

/** What a scratch database's name looks like: the prefix, then a UUIDv7. */
const NAME = /^tetsu_sql_([0-9a-f]{12})7[0-9a-f]{19}$/;

/** How old a scratch database is when it is taken as left behind. */
const LEFT_BEHIND_MS = 60 * 60 * 1000;

/**
 * The URL of another database of the same server: the same user, host,
 * port and parameters, such as `sslmode` and `options`, as written.
 */
export function urlOf(url: string, database: string): string {
  const next = new URL(url);

  next.pathname = `/${encodeURIComponent(database)}`;

  return next.href;
}

/**
 * Creates an empty database on the server of the database `url` names,
 * with a client of it. Both connections are made from `url` itself, so
 * what it says — `sslmode`, `options` with a `search_path` — holds for
 * each, and nothing of the environment does: not even `PGDATABASE`, which
 * Bun 1.4.3 takes over the database a URL names. The user needs the right
 * to create databases.
 */
export async function createScratch(url: string): Promise<Scratch> {
  const server = clientOf(url);
  const name = `tetsu_sql_${Bun.randomUUIDv7().replaceAll("-", "")}`;

  try {
    await dropLeftBehind(server);
    await server.unsafe(`create database ${name} template template0`);
  } catch (error) {
    await server.close();

    throw (error as { errno?: unknown }).errno === "42501"
      ? new Error(
          `cannot create a scratch database, which takes the right to create databases: ${(error as Error).message}`,
          { cause: error },
        )
      : error;
  }

  const scratch = clientOf(urlOf(url, name));

  return {
    name,
    sql: scratch,
    async drop() {
      try {
        await scratch.close();
        await server.unsafe(`drop database ${name} with (force)`);
      } finally {
        await server.close();
      }
    },
  };
}

/**
 * Drops the scratch databases more than an hour old: a run that was killed
 * left them. One that another user owns, or that another run drops first,
 * is left as it is.
 */
async function dropLeftBehind(server: SQL): Promise<void> {
  const rows: { name: string }[] = await server`
    select datname as name from pg_database
    where datname ~ '^tetsu_sql_[0-9a-f]{12}7[0-9a-f]{19}$'`;

  for (const { name } of rows) {
    const made = Number.parseInt(NAME.exec(name)?.[1] ?? "", 16);

    if (Date.now() - made > LEFT_BEHIND_MS) {
      await server
        .unsafe(`drop database if exists ${name} with (force)`)
        .catch(() => undefined);
    }
  }
}
