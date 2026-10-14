/**
 * The targets of the SQL benchmark, `../sql.ts`, and the database they run
 * on. Each target makes the same four operations the way an application
 * on its library writes them, on a pool of the same size.
 *
 * A target is built in the process that measures it, `worker.ts`, and
 * imports its libraries as it is built, so that a process holds only its
 * own.
 *
 * @module
 */

import type { FileQuery, Schema } from "@tetsujs/sql";
import { SQL } from "bun";
import type { GeneratedAlways, Kysely, Transaction } from "kysely";

/** The items the reads find, keyed 1 to `ITEMS`. */
export const ITEMS = 10_000;

/** Operations in flight at once, each on a lane of its own. */
export const LANES = 32;

/** Connections in each target's pool: Bun's default. */
export const POOL = 10;

/** The note of an event a target inserts. */
const NOTE = "bench";

/** The instant item 0 would have been created at; each item a minute on. */
const EPOCH = Date.UTC(2026, 9, 13, 12);

/**
 * The tables, created and filled on a database of their own: the items
 * the reads find, the events the inserts add, and two accounts to each
 * lane, which its transactions move a unit between.
 */
export const SEED = `
  create table items (
    id int8 primary key,
    name text not null,
    price numeric(10, 2) not null,
    created timestamptz not null
  );
  insert into items
    select g, 'item ' || g, g * 1.5,
           to_timestamp(${EPOCH / 1000}) + g * interval '1 minute'
    from generate_series(1, ${ITEMS}) g;
  create table events (
    id int8 generated always as identity primary key,
    item_id int8 not null references items (id),
    note text not null
  );
  create table accounts (id int8 primary key, balance int8 not null);
  insert into accounts select g, 1000 from generate_series(1, ${LANES * 2}) g;
  analyze;
`;

/** Item `id`, as every target reads it back. */
export function item(id: bigint): Record<string, unknown> {
  return {
    id,
    name: `item ${id}`,
    price: (Number(id) * 1.5).toFixed(2),
    created: new Date(EPOCH + Number(id) * 60_000),
  };
}

/** The operations, as a target makes them. */
export interface Target {
  /** Reads an item by its key. */
  one(id: bigint): Promise<readonly unknown[]>;

  /** Reads the 100 items after a key, in order. */
  hundred(after: bigint): Promise<readonly unknown[]>;

  /** Inserts an event of an item, and returns its key. */
  insert(item: bigint): Promise<readonly unknown[]>;

  /** Moves a unit from an account to another, in a transaction. */
  transfer(from: bigint, to: bigint): Promise<unknown>;

  /** Closes its pool. */
  close(): Promise<unknown>;
}

/** The tables, as Kysely types them. */
interface Database {
  readonly items: {
    readonly id: bigint;
    readonly name: string;
    readonly price: string;
    readonly created: Date;
  };
  readonly events: {
    readonly id: GeneratedAlways<bigint>;
    readonly item_id: bigint;
    readonly note: string;
  };
  readonly accounts: { readonly id: bigint; readonly balance: bigint };
}

/**
 * What a generated file holds for these tables: no column of arrays, and
 * no migration, as `database()` reads neither.
 */
const schema: Schema<Database> = {
  journal: "migrations",
  migration: null,
  arrays: {},
};

/** The operations as query files: the SQL a generated function runs. */
const FILES = {
  one: {
    text: "select id, name, price, created from items where id = $1",
    names: ["id"],
    arrays: {},
  },
  hundred: {
    text: "select id, name, price, created from items where id > $1 order by id limit 100",
    names: ["after"],
    arrays: {},
  },
  insert: {
    text: "insert into events (item_id, note) values ($1, $2) returning id",
    names: ["item", "note"],
    arrays: {},
  },
  debit: {
    text: "update accounts set balance = balance - 1 where id = $1",
    names: ["id"],
    arrays: {},
  },
  credit: {
    text: "update accounts set balance = balance + 1 where id = $1",
    names: ["id"],
    arrays: {},
  },
} satisfies Record<string, FileQuery>;

/** A pool of `POOL` connections, reading an `int8` as a `bigint`. */
function pool(url: string): SQL {
  return new SQL({ url, bigint: true, max: POOL });
}

/** Bun.SQL alone, with its tagged templates and `begin()`. */
async function bun(url: string): Promise<Target> {
  const sql = pool(url);

  return {
    one: (id) =>
      sql`select id, name, price, created from items where id = ${id}`,
    hundred: (after) =>
      sql`select id, name, price, created from items where id > ${after} order by id limit 100`,
    insert: (item) =>
      sql`insert into events (item_id, note) values (${item}, ${NOTE}) returning id`,
    transfer: (from, to) =>
      sql.begin(async (tx) => {
        await tx`update accounts set balance = balance - 1 where id = ${from}`;
        await tx`update accounts set balance = balance + 1 where id = ${to}`;
      }),
    close: () => sql.close(),
  };
}

/**
 * The operations on Kysely's builder, `db`, with transactions run by
 * `atomically`.
 */
async function builder(
  db: Kysely<Database>,
  atomically: (
    work: (trx: Transaction<Database>) => Promise<void>,
  ) => Promise<void>,
): Promise<Target> {
  const { sql } = await import("kysely");

  return {
    one: (id) =>
      db
        .selectFrom("items")
        .select(["id", "name", "price", "created"])
        .where("id", "=", id)
        .execute(),
    hundred: (after) =>
      db
        .selectFrom("items")
        .select(["id", "name", "price", "created"])
        .where("id", ">", after)
        .orderBy("id")
        .limit(100)
        .execute(),
    insert: (item) =>
      db
        .insertInto("events")
        .values({ item_id: item, note: NOTE })
        .returning("id")
        .execute(),
    transfer: (from, to) =>
      atomically(async (trx) => {
        await trx
          .updateTable("accounts")
          .set({ balance: sql`balance - 1` })
          .where("id", "=", from)
          .execute();
        await trx
          .updateTable("accounts")
          .set({ balance: sql`balance + 1` })
          .where("id", "=", to)
          .execute();
      }),
    close: () => db.destroy(),
  };
}

/** `@tetsujs/sql`: `database()`, its builder, and `atomic()`. */
async function tetsu(url: string): Promise<Target> {
  const { atomic, database } = await import("@tetsujs/sql");
  const db = database(schema, { url, max: POOL });

  return builder(db, (work) => atomic(db, work));
}

/**
 * `@tetsujs/sql` with query files: the functions a generated file holds
 * for them, which take the database or a transaction.
 */
async function tetsuFiles(url: string): Promise<Target> {
  const { atomic, database, queryCount, queryRows } = await import(
    "@tetsujs/sql"
  );
  const db = database(schema, { url, max: POOL });
  const one = (on: Kysely<Database>, params: { id: bigint }) =>
    queryRows(on, FILES.one, params);
  const hundred = (on: Kysely<Database>, params: { after: bigint }) =>
    queryRows(on, FILES.hundred, params);
  const insert = (
    on: Kysely<Database>,
    params: { item: bigint; note: string },
  ) => queryRows(on, FILES.insert, params);
  const debit = (on: Kysely<Database>, params: { id: bigint }) =>
    queryCount(on, FILES.debit, params);
  const credit = (on: Kysely<Database>, params: { id: bigint }) =>
    queryCount(on, FILES.credit, params);

  return {
    one: (id) => one(db, { id }),
    hundred: (after) => hundred(db, { after }),
    insert: (item) => insert(db, { item, note: NOTE }),
    transfer: (from, to) =>
      atomic(db, async (trx) => {
        await debit(trx, { id: from });
        await credit(trx, { id: to });
      }),
    close: () => db.destroy(),
  };
}

/**
 * Kysely on the package's driver alone, without what `database()` adds:
 * where Kysely's cost ends and the package's begins.
 */
async function kysely(url: string): Promise<Target> {
  const { Kysely } = await import("kysely");
  const { BunDialect } = await import("../../../packages/sql/src/driver.ts");
  const db = new Kysely<Database>({
    dialect: new BunDialect(pool(url), new SQL({ url, bigint: true, max: 1 })),
  });

  return builder(db, (work) => db.transaction().execute(work));
}

/**
 * Drizzle on the same Bun.SQL client, its queries built for each call,
 * or `prepared` once and run with their values.
 */
async function drizzle(url: string, prepared: boolean): Promise<Target> {
  const { asc, eq, gt, sql } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/bun-sql");
  const { bigint, numeric, pgTable, text, timestamp } = await import(
    "drizzle-orm/pg-core"
  );
  const items = pgTable("items", {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    name: text("name").notNull(),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    created: timestamp("created", { withTimezone: true }).notNull(),
  });
  const events = pgTable("events", {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    itemId: bigint("item_id", { mode: "bigint" }).notNull(),
    note: text("note").notNull(),
  });
  const accounts = pgTable("accounts", {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    balance: bigint("balance", { mode: "bigint" }).notNull(),
  });
  const client = pool(url);
  const db = drizzle({ client });
  const transfer = (from: bigint, to: bigint) =>
    db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ balance: sql`${accounts.balance} - 1` })
        .where(eq(accounts.id, from));
      await tx
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + 1` })
        .where(eq(accounts.id, to));
    });
  const close = () => client.close();

  if (!prepared) {
    return {
      one: (id) => db.select().from(items).where(eq(items.id, id)),
      hundred: (after) =>
        db
          .select()
          .from(items)
          .where(gt(items.id, after))
          .orderBy(asc(items.id))
          .limit(100),
      insert: (item) =>
        db
          .insert(events)
          .values({ itemId: item, note: NOTE })
          .returning({ id: events.id }),
      transfer,
      close,
    };
  }

  const one = db
    .select()
    .from(items)
    .where(eq(items.id, sql.placeholder("id")))
    .prepare("one");
  const hundred = db
    .select()
    .from(items)
    .where(gt(items.id, sql.placeholder("after")))
    .orderBy(asc(items.id))
    .limit(100)
    .prepare("hundred");
  const insert = db
    .insert(events)
    .values({ itemId: sql.placeholder("item"), note: NOTE })
    .returning({ id: events.id })
    .prepare("insert");

  return {
    one: (id) => one.execute({ id }),
    hundred: (after) => hundred.execute({ after }),
    insert: (item) => insert.execute({ item }),
    transfer,
    close,
  };
}

/** Each target, by the name `ONLY` takes. */
export const targets: Readonly<
  Record<string, (url: string) => Promise<Target>>
> = {
  bun,
  tetsu,
  "tetsu-files": tetsuFiles,
  kysely,
  drizzle: (url) => drizzle(url, false),
  "drizzle-prepared": (url) => drizzle(url, true),
};
