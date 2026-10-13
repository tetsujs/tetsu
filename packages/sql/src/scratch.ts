/**
 * Scratch databases: an empty database of its own on a server, for as long
 * as the generator, or a test file, needs one.
 *
 * Each is created from `template0`, so that nothing an administrator put
 * in `template1` reaches it: what it holds is what the migrations build.
 * Its name, `tetsu_sql_` and a UUIDv7, carries the time it was made, and a
 * run that was killed before it dropped its database leaves one that the
 * next run on the server drops: once it is an hour old by the server's
 * clock, which a test that moves its own clock does not move, and only
 * while no session is on it.
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
const NAME = /^tetsu_sql_[0-9a-f]{12}7[0-9a-f]{19}$/;

/**
 * How long closing a client may take before it is given up on: Bun's
 * `close()` now and then never settles.
 */
const CLOSE_MS = 5000;

/**
 * The URL of another database of the same server: the same user, host,
 * port and parameters, such as `sslmode` and `options`, as written.
 */
export function urlOf(url: string, database: string): string {
  const next = new URL(url);

  next.pathname = `/${encodeURIComponent(database)}`;

  return next.href;
}

/** A name for a scratch database of its own: the prefix, then a UUIDv7. */
export function scratchName(): string {
  return `tetsu_sql_${Bun.randomUUIDv7().replaceAll("-", "")}`;
}

/**
 * Creates an empty database on the server of the database `url` names,
 * with a client of it: named `name`, a {@link scratchName} by default.
 * Both connections are made from `url` itself, so what it says —
 * `sslmode`, `options` with a `search_path` — holds for each, and nothing
 * of the environment does: not even `PGDATABASE`, which Bun 1.4.3 takes
 * over the database a URL names. The user needs the right to create
 * databases.
 */
export async function createScratch(
  url: string,
  name = scratchName(),
): Promise<Scratch> {
  if (!NAME.test(name)) {
    throw new TypeError(`${name} is not the name of a scratch database`);
  }

  const server = clientOf(url);

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
        await closed(scratch);
        await server.unsafe(`drop database ${name} with (force)`);
      } finally {
        await closed(server);
      }
    },
  };
}

/**
 * Drops the scratch databases more than an hour old by the server's clock,
 * which the time in their names is read against: a run that was killed
 * left them. One a session is still on is in use, however old its name,
 * and so is one that another user owns or another run drops first: each
 * is left as it is.
 */
async function dropLeftBehind(server: SQL): Promise<void> {
  const rows: { name: string }[] = await server`
    select datname as name from pg_database
    where datname ~ '^tetsu_sql_[0-9a-f]{12}7[0-9a-f]{19}$'
      and to_timestamp(('x' || substr(datname, 11, 12))::bit(48)::bigint / 1000.0)
        < now() - interval '1 hour'`;

  for (const { name } of rows) {
    await server
      .unsafe(`drop database if exists ${name}`)
      .catch(() => undefined);
  }
}

/** Closes a client, or stops waiting once {@link CLOSE_MS} have passed. */
async function closed(client: SQL): Promise<void> {
  let timer: Timer | undefined;

  await Promise.race([
    client.close(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_MS);
    }),
  ]);
  clearTimeout(timer);
}
