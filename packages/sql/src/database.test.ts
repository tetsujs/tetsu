/**
 * `database()` against a real Postgres, on the database the fixture
 * migrations build and with the file generated from them: every type of
 * array goes in through Kysely and comes back as the generated types say,
 * with parameters and without, and the places a query writes an array to
 * a column of arrays write it as Postgres reads it; and `db.connection()`
 * keeps one session, on `db` and on the Kysely made from it.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Insertable, KyselyPlugin, Selectable } from "kysely";
import { Kysely, sql } from "kysely";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import { schema } from "../test-utils/fixtures/schema/db.generated.ts";
import type { DatabaseOptions } from "./database.ts";
import { checkBun, database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { queryRows } from "./queries.ts";

let db: Kysely<DB>;

afterAll(async () => {
  await db.destroy();
});

const { sql: client, url } = testDatabase();

db = database(schema, { url });

beforeAll(async () => {
  await migrate(client, {
    dir: join(import.meta.dir, "../test-utils/fixtures/schema/migrations"),
  });
}, DATABASE_MS);

/** A row of `arrays` read back without parameters, and with one. */
async function readBack(): Promise<
  [Selectable<DB["arrays"]>, Selectable<DB["arrays"]>]
> {
  const text = await db.selectFrom("arrays").selectAll().execute();
  const binary = await db
    .selectFrom("arrays")
    .selectAll()
    .where(sql<boolean>`${true}`)
    .execute();

  return [text[0] ?? {}, binary[0] ?? {}] as never;
}

/**
 * Each column of `arrays`, with what is written to it and what it reads
 * back as: an array, or the literal Bun reads some types as.
 */
const columns: readonly [keyof DB["arrays"], unknown, unknown][] = [
  ["a_bool", [true, false, null], [true, false, null]],
  ["a_int2", [1, -2, null], [1, -2, null]],
  ["a_int4", [1, 2147483647, -5], [1, 2147483647, -5]],
  ["a_oid", [1, 4294967295], [1, 4294967295]],
  ["a_int8", [1n, -9007199254740993n, null], [1n, -9007199254740993n, null]],
  ["a_float4", [1.5, -0.25], [1.5, -0.25]],
  [
    "a_float8",
    [1.1, Number.POSITIVE_INFINITY, null],
    [1.1, Number.POSITIVE_INFINITY, null],
  ],
  ["a_numeric", ["1.50", "-3", "NaN"], ["1.50", "-3", "NaN"]],
  ["a_money", ["12.50"], ["$12.50"]],
  [
    "a_text",
    [
      "a",
      "",
      "NULL",
      null,
      'q"uote',
      "back\\slash",
      "a,b",
      "{c}",
      " d ",
      "注文",
    ],
    [
      "a",
      "",
      "NULL",
      null,
      'q"uote',
      "back\\slash",
      "a,b",
      "{c}",
      " d ",
      "注文",
    ],
  ],
  ["a_varchar", ["x", null], ["x", null]],
  ["a_bpchar", ["a", "bc"], ["a ", "bc"]],
  ["a_name", ["pg_class"], ["pg_class"]],
  ["a_char", ["a", "b"], ["a", "b"]],
  [
    "a_uuid",
    ["0190d0a1-7f6e-7c3a-8f6e-1234567890ab", null],
    ["0190d0a1-7f6e-7c3a-8f6e-1234567890ab", null],
  ],
  ["a_json", [{ a: 1 }, [1, "two"], null], [{ a: 1 }, [1, "two"], null]],
  ["a_jsonb", [{ a: 1, b: [true] }, null], [{ a: 1, b: [true] }, null]],
  [
    "a_timestamp",
    [new Date("2026-10-12T10:20:30.456Z"), "2026-10-13 01:02:03"],
    [new Date("2026-10-12T10:20:30.456Z"), new Date("2026-10-13T01:02:03Z")],
  ],
  [
    "a_timestamptz",
    [new Date("2026-10-12T10:20:30.456Z"), null],
    [new Date("2026-10-12T10:20:30.456Z"), null],
  ],
  [
    "a_date",
    [new Date("2026-10-12T00:00:00Z"), "2026-10-13"],
    [new Date("2026-10-12T00:00:00Z"), new Date("2026-10-13T00:00:00Z")],
  ],
  ["a_time", ["10:20:30", null], ["10:20:30", null]],
  ["a_timetz", ["10:20:30+03"], ["10:20:30+03"]],
  ["a_interval", ["1 day 02:00:00"], ["1 day 02:00:00"]],
  [
    "a_bytea",
    [Buffer.from("hi"), new Uint8Array([0, 255]), null],
    [Buffer.from("hi"), Buffer.from([0, 255]), null],
  ],
  ["a_inet", ["192.168.0.1/24"], ["192.168.0.1/24"]],
  ["a_cidr", ["10.0.0.0/8"], ["10.0.0.0/8"]],
  ["a_macaddr", ["08:00:2b:01:02:03"], ["08:00:2b:01:02:03"]],
  ["a_macaddr8", ["08:00:2b:01:02:03:04:05"], ["08:00:2b:01:02:03:04:05"]],
  ["a_bit", ["101"], ["101"]],
  ["a_varbit", ["1", "10"], ["1", "10"]],
  ["a_point", ["(1,2)"], ["(1,2)"]],
  ["a_line", ["{1,2,3}"], ["{1,2,3}"]],
  ["a_lseg", ["[(0,0),(1,1)]"], ["[(0,0),(1,1)]"]],
  ["a_box", ["(1,1),(0,0)", "(3,3),(2,2)"], ["(1,1),(0,0)", "(3,3),(2,2)"]],
  ["a_path", ["[(0,0),(1,1)]"], ["[(0,0),(1,1)]"]],
  ["a_polygon", ["((0,0),(1,1),(1,0))"], ["((0,0),(1,1),(1,0))"]],
  ["a_circle", ["<(0,0),1>"], ["<(0,0),1>"]],
  ["a_xml", ["<a>x</a>"], ["<a>x</a>"]],
  ["a_tsvector", ["a b"], ["'a' 'b'"]],
  ["a_tsquery", ["a & b"], ["'a' & 'b'"]],
  ["a_pg_lsn", ["16/B374D848"], ["16/B374D848"]],
  ["a_int4range", ["[1,3)", "empty", null], ["[1,3)", "empty", null]],
  ["a_int4multirange", ["{[1,3)}"], ["{[1,3)}"]],
  ["a_regclass", ["pg_class"], ["pg_class"]],
  ["a_citext", ["Abc", null], "{Abc,NULL}"],
  ["a_order_status", ["new", "paid"], "{new,paid}"],
  ["a_positive", [1, 2], "{1,2}"],
  ["a_kind", ["retail"], "{retail}"],
  ["a_pair", ["(1,x)", '(2,"y z")'], '{"(1,x)","(2,\\"y z\\")"}'],
  ["a_float_range", ["[1.5,2.5)"], '{"[1.5,2.5)"}'],
];

describe("an array of each type", () => {
  test("goes in through an insert, and reads back as its type says, with parameters and without", async () => {
    const row = Object.fromEntries(
      columns.map(([column, written]) => [column, written]),
    ) as Insertable<DB["arrays"]>;

    await db.deleteFrom("arrays").execute();
    await db.insertInto("arrays").values(row).execute();

    const [text, binary] = await readBack();
    const expected = Object.fromEntries(
      columns.map(([column, , read]) => [column, read]),
    );

    expect(text).toEqual(expected as never);
    expect(binary).toEqual(expected as never);
  });

  test("goes in through an update, one column at a time", async () => {
    await db.deleteFrom("arrays").execute();
    await db.insertInto("arrays").defaultValues().execute();

    for (const [column, written, read] of columns) {
      await db
        .updateTable("arrays")
        .set({ [column]: written } as never)
        .execute();

      const [text, binary] = await readBack();

      expect<unknown>([column, text[column]]).toEqual([column, read]);
      expect<unknown>([column, binary[column]]).toEqual([column, read]);
    }
  });

  test("of int4 or float4 that holds a NULL reads the same with parameters and without", async () => {
    await db.deleteFrom("arrays").execute();
    await db
      .insertInto("arrays")
      .values({ a_int4: [1, null], a_float4: [null, 1.5] })
      .execute();

    const [text] = await db
      .selectFrom("arrays")
      .select(["a_int4", "a_float4"])
      .execute();
    const [binary] = await db
      .selectFrom("arrays")
      .select(["a_int4", "a_float4"])
      .where(sql<boolean>`${true}`)
      .execute();

    expect(text).toEqual({ a_int4: [1, null], a_float4: [null, 1.5] });
    expect(binary).toEqual({ a_int4: [1, null], a_float4: [null, 1.5] });
  });

  test("covers every column of arrays the generated file names", () => {
    expect(columns.map(([column]) => column)).toEqual(
      Object.keys(schema.arrays.arrays ?? {}) as never,
    );
  });
});

describe("an array read back and written again", () => {
  interface Grids {
    readonly grids: {
      readonly id: number;
      readonly cells: string[] | null;
      readonly boxes: string[] | null;
      readonly documents: unknown[] | null;
    };
  }

  test("of two dimensions keeps them, and of json keeps each array an element", async () => {
    await client`
      create table grids (
        id int4 primary key, cells text[][], boxes box[][], documents jsonb[]
      )`;
    await client`
      insert into grids values (
        1,
        '{{a,"b,c"},{d,NULL}}',
        '{{(1,1),(0,0);(2,2),(1,1)}}',
        array['[1, 2]', '{"a": 1}', null]::jsonb[]
      )`;

    const grids = database<Grids>(
      {
        journal: "migrations",
        migration: null,
        arrays: { grids: { cells: ",", boxes: ";", documents: "json" } },
      },
      { url },
    );

    try {
      const read = await grids
        .selectFrom("grids")
        .select(["cells", "boxes", "documents"])
        .where("id", "=", 1)
        .executeTakeFirstOrThrow();

      expect(read).toEqual({
        cells: [
          ["a", "b,c"],
          ["d", null],
        ] as never,
        boxes: [["(1,1),(0,0)", "(2,2),(1,1)"]] as never,
        documents: [[1, 2], { a: 1 }, null],
      });

      await grids.updateTable("grids").set(read).where("id", "=", 1).execute();
    } finally {
      await grids.destroy();
    }

    const [stored] = await client`
      select cells::text as cells, array_ndims(cells) as "cellDimensions",
             boxes::text as boxes, array_ndims(boxes) as "boxDimensions",
             documents::text as documents,
             array_ndims(documents) as "documentDimensions"
      from grids where id = 1`;

    expect(stored).toEqual({
      cells: '{{a,"b,c"},{d,NULL}}',
      cellDimensions: 2,
      boxes: "{{(1,1),(0,0);(2,2),(1,1)}}",
      boxDimensions: 2,
      documents: '{"[1, 2]","{\\"a\\": 1}",NULL}',
      documentDimensions: 1,
    });
  });
});

/** The columns an order cannot go without. */
const order = {
  kind: "retail",
  channel: "web",
  quantity: 1,
  amount: "12.50",
  note: "fragile",
  outer_kind: "a",
  required_attributes: "colour=>red",
} as const;

describe("an order", () => {
  test("keeps its arrays, of a domain and of an enum, and its jsonb as JSON", async () => {
    const moment = new Date("2026-10-12T10:00:00Z");
    const [{ id }] = [
      await db
        .insertInto("orders")
        .values({
          ...order,
          tags: ["gift", "fragile"],
          labels: ["a"],
          notes: ["n", null],
          scores: [1, 2],
          coupons: ["0190d0a1-7f6e-7c3a-8f6e-1234567890ab"],
          history: ["new", "paid"],
          kinds: ["bulk"],
          moments: [moment],
          payload: [1, { two: 2 }],
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    ];
    const stored = await db
      .selectFrom("orders")
      .select([
        "tags",
        "labels",
        "notes",
        "scores",
        "coupons",
        "history",
        "kinds",
        "payload",
        sql<string>`moments::text`.as("moments"),
        sql<string>`jsonb_typeof(payload)`.as("payload_type"),
      ])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    expect(stored).toEqual({
      tags: ["gift", "fragile"],
      labels: ["a"],
      notes: ["n", null],
      scores: [1, 2],
      coupons: ["0190d0a1-7f6e-7c3a-8f6e-1234567890ab"],
      history: "{new,paid}",
      kinds: "{bulk}",
      payload: [1, { two: 2 }],
      moments: '{"2026-10-12 10:00:00+00"}',
      payload_type: "array",
    });
  });

  test("is found by an array compared with a column of arrays, and by any()", async () => {
    const { id } = await db
      .insertInto("orders")
      .values({ ...order, tags: ["findable", "x"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    const contains = await db
      .selectFrom("orders")
      .select("id")
      .where("tags", "@>", ["findable"])
      .execute();
    const overlaps = await db
      .selectFrom("orders as o")
      .select("o.id")
      .where("o.tags", "&&", (eb) => eb.val(["x", "missing"]))
      .execute();
    const among = await db
      .selectFrom("orders")
      .select("id")
      .where((eb) => eb("id", "=", eb.fn.any(eb.val([id, -1n]))))
      .execute();

    expect(contains).toEqual([{ id }]);
    expect(overlaps).toEqual([{ id }]);
    expect(among).toEqual([{ id }]);
  });

  test("takes the arrays of an upsert's update", async () => {
    const { id } = await db
      .insertInto("orders")
      .values({ ...order, email: "upsert@example.com", tags: ["first"] })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("orders")
      .values({ ...order, email: "upsert@example.com", tags: ["ignored"] })
      .onConflict((conflict) =>
        conflict
          .column("email")
          .where("status", "=", "new")
          .doUpdateSet({ tags: ["second", "third"] }),
      )
      .execute();

    const stored = await db
      .selectFrom("orders")
      .select("tags")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    expect(stored.tags).toEqual(["second", "third"]);
  });

  test("takes the arrays of a merge, from Postgres 15 on", async () => {
    const [server] = (
      await sql<{
        version: number;
      }>`select current_setting('server_version_num')::int as version`.execute(
        db,
      )
    ).rows;

    if (server === undefined || server.version < 150000) {
      return;
    }

    const { id } = await db
      .insertInto("orders")
      .values({ ...order, tags: ["before"] })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .mergeInto("orders as t")
      .using(
        db.selectFrom("orders").select("id").where("id", "=", id).as("s"),
        "s.id",
        "t.id",
      )
      .whenMatched()
      .thenUpdateSet({ tags: ["merged"] })
      .execute();

    const stored = await db
      .selectFrom("orders")
      .select("tags")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    expect(stored.tags).toEqual(["merged"]);
  });
});

describe("the client", () => {
  test("reads int8 as a bigint, whatever the options say", async () => {
    const forced = database(schema, {
      url,
      bigint: false,
    } as DatabaseOptions);

    try {
      const { rows } = await sql<{
        big: unknown;
      }>`select 9007199254740993::int8 as big`.execute(forced);

      expect(rows).toEqual([{ big: 9007199254740993n }]);
    } finally {
      await forced.destroy();
    }
  });

  test("reads int8 as a string for types generated with int8 read as one, and writes a string, a number or a bigint to it", async () => {
    const strings = database({ ...schema, int8: "string" }, { url });

    try {
      for (const where of [sql`true`, sql`${true}`]) {
        const { rows } = await sql`
          select 9007199254740993::int8 as big,
            array[1, 9007199254740993]::int8[] as list,
            ${"9007199254740993"}::int8 as text, ${42}::int8 as number,
            ${42n}::int8 as bigint
          where ${where}`.execute(strings);

        expect(rows).toEqual([
          {
            big: "9007199254740993",
            list: ["1", "9007199254740993"],
            text: "9007199254740993",
            number: "42",
            bigint: "42",
          },
        ]);
      }
    } finally {
      await strings.destroy();
    }
  });

  test("reaches the database its URL names, whatever PGDATABASE says", async () => {
    process.env.PGDATABASE = "postgres";

    const elsewhere = database(schema, { url });

    try {
      const { rows } = await sql<{
        name: string;
      }>`select current_database() as name`.execute(elsewhere);

      expect(rows).toEqual([{ name: new URL(url).pathname.slice(1) }]);
    } finally {
      delete process.env.PGDATABASE;
      await elsewhere.destroy();
    }
  });

  test("of a URL that names no database reaches the one of its user's name, whatever PGDATABASE says", async () => {
    const bare = new URL(url);

    bare.pathname = "";
    process.env.PGDATABASE = "tetsu_sql_nowhere";

    const elsewhere = database(schema, { url: bare.href });

    try {
      const { rows } = await sql<{
        name: string;
      }>`select current_database() as name`.execute(elsewhere);

      expect(rows).toEqual([{ name: decodeURIComponent(bare.username) }]);
    } finally {
      delete process.env.PGDATABASE;
      await elsewhere.destroy();
    }
  });

  test("is refused for a URL of another kind of database", () => {
    expect(() => database(schema, { url: "sqlite://types.db" })).toThrow(
      new TypeError(
        "database runs on Postgres: url must be a postgres:// or postgresql:// URL",
      ),
    );
    expect(() => database(schema, { url: "" })).toThrow(TypeError);
  });
});

describe("db.connection()", () => {
  /** A plugin that changes nothing. */
  const unchanged: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => result,
  };

  /** The process id of the backend a query of `on` runs on. */
  async function pidOf(on: Kysely<DB>): Promise<number | undefined> {
    const { rows } = await sql<{
      pid: number;
    }>`select pg_backend_pid() as pid`.execute(on);

    return rows[0]?.pid;
  }

  test.each([
    ["db", (made: Kysely<DB>) => made],
    [
      "a Kysely of withSchema()",
      (made: Kysely<DB>) => made.withSchema("public"),
    ],
    [
      "a Kysely of withPlugin()",
      (made: Kysely<DB>) => made.withPlugin(unchanged),
    ],
    [
      "a Kysely of two methods",
      (made: Kysely<DB>) => made.withoutPlugins().withSchema("public"),
    ],
  ])(
    "on %s keeps one session for its work, while a transaction takes a connection of the pool",
    async (_, on) => {
      const small = database(schema, { url, max: 3 });

      try {
        const work = await on(small)
          .connection()
          .execute(async (connection) => {
            await sql`set tetsu.mark to 'kept'`.execute(connection);

            const first = await pidOf(connection);
            const trx = await small.startTransaction().execute();

            try {
              const { rows } = await sql<{
                mark: string | null;
              }>`select current_setting('tetsu.mark', true) as mark`.execute(
                connection,
              );

              return {
                first,
                second: await pidOf(connection),
                mark: rows[0]?.mark,
                transaction: await pidOf(trx),
              };
            } finally {
              await trx.rollback().execute();
            }
          });

        expect(work).toEqual({
          first: expect.any(Number),
          second: work.first,
          mark: "kept",
          transaction: expect.any(Number),
        });
        expect(work.transaction).not.toBe(work.first);
      } finally {
        await small.destroy();
      }
    },
  );

  test("runs a transaction of its work on its connection", async () => {
    const work = await db.connection().execute(async (connection) => {
      const first = await pidOf(connection);
      const inside = await connection
        .transaction()
        .execute(async (trx) => pidOf(trx));

      return { first, inside, after: await pidOf(connection) };
    });

    expect(work).toEqual({
      first: expect.any(Number),
      inside: work.first,
      after: work.first,
    });
  });

  test("gives up, its work never run, once its signal is aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("gave up");
    let ran = false;

    controller.abort(reason);

    const outcome = await db
      .connection()
      .execute(
        async () => {
          ran = true;
        },
        { signal: controller.signal },
      )
      .then(
        () => "resolved",
        (error: unknown) => error,
      );

    expect(outcome).toBe(reason);
    expect(ran).toBe(false);
  });
});

describe("a number", () => {
  /** A table of each kind of number, which the fixture's types do not hold. */
  type Numbers = {
    numbers: {
      id: number;
      i2: number | null;
      i4: number | null;
      i8: bigint | number | null;
      f4: number | null;
      f8: number | null;
      n: number | string | null;
    };
  };

  const numbers = () => db.withTables<Numbers>();

  beforeAll(async () => {
    await client`
      create table numbers (
        id int4 primary key, i2 int2, i4 int4, i8 int8, f4 float4, f8 float8, n numeric
      )`;
  });

  /** The SQLSTATE a query fails with. */
  async function sqlstate(query: Promise<unknown>): Promise<unknown> {
    try {
      await query;
    } catch (error) {
      return (error as { errno?: unknown }).errno;
    }

    throw new Error("the query did not fail");
  }

  test("that is not whole is refused where a write puts it in an integer column, not rounded", async () => {
    for (const column of ["i2", "i4", "i8"] as const) {
      for (const value of [2.5, 3.5, 0.1 + 0.2, Number.NaN]) {
        expect(
          await sqlstate(
            numbers()
              .insertInto("numbers")
              .values({ id: 1, [column]: value })
              .execute(),
          ),
        ).toBe("22P02");
      }
    }

    expect(
      await sqlstate(
        numbers()
          .updateTable("numbers")
          .set({ i4: 2.5 })
          .where("id", "=", 1)
          .execute(),
      ),
    ).toBe("22P02");
    expect(
      await sqlstate(
        numbers()
          .insertInto("numbers")
          .values({ id: 1, i4: 1 })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({ i4: 2.5 }),
          )
          .execute(),
      ),
    ).toBe("22P02");

    const { rows } = await sql`select count(*) as count from numbers`.execute(
      db,
    );

    expect(rows).toEqual([{ count: 0n }]);
  });

  test("that is not whole goes into a float8, a float4 and a numeric as the number it is", async () => {
    const row = await numbers()
      .insertInto("numbers")
      .values({ id: 2, f4: 2.5, f8: 0.1 + 0.2, n: 0.1 + 0.2 })
      .returning(["f4", "f8", "n"])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      f4: 2.5,
      f8: 0.30000000000000004,
      n: "0.30000000000000004",
    });
  });

  test("that is not whole is bound as Bun binds it where it is compared or computed with", async () => {
    await numbers().insertInto("numbers").values({ id: 3, i4: 3 }).execute();

    const compared = await numbers()
      .selectFrom("numbers")
      .select("id")
      .where("i4", ">", 2.5)
      .where("id", "=", 3)
      .execute();
    const computed = await numbers()
      .selectFrom("numbers")
      .select((eb) => eb("i4", "*", 1.5).as("product"))
      .where("id", "=", 3)
      .executeTakeFirstOrThrow();

    expect(compared).toEqual([{ id: 3 }]);
    expect(computed).toEqual({ product: 4.5 });
  });

  test("that is not whole and written into the SQL, as a literal, is left to Postgres", async () => {
    const rows = await numbers()
      .insertInto("numbers")
      .values((eb) => ({ id: 6, i4: eb.lit(2.5) }))
      .returning("i4")
      .execute();
    const raw = await numbers()
      .updateTable("numbers")
      .set({ i4: sql.lit(3.5) })
      .where("id", "=", 6)
      .returning("i4")
      .execute();

    expect([rows, raw]).toEqual([[{ i4: 3 }], [{ i4: 4 }]]);
  });

  test("that is not whole is bound as Bun binds it in raw SQL, which says nothing of where it goes", async () => {
    const { rows } = await sql`
      insert into numbers (id, i4) values (4, ${2.5}) returning i4`.execute(db);

    expect(rows).toEqual([{ i4: 2 }]);
  });

  test("that is not whole is refused by an integer parameter of a query file, and read by a numeric one", async () => {
    expect(
      await sqlstate(
        queryRows(
          db,
          { text: "select $1::int4 as n", names: ["n"], arrays: {} },
          { n: 2.5 },
        ),
      ),
    ).toBe("22P02");
    expect(
      await queryRows(
        db,
        { text: "select $1::numeric as n", names: ["n"], arrays: {} },
        { n: 0.1 + 0.2 },
      ),
    ).toEqual([{ n: "0.30000000000000004" }]);
  });

  test("that is whole is written as Bun binds it", async () => {
    const row = await numbers()
      .insertInto("numbers")
      .values({ id: 5, i4: 7, i8: 2 ** 60, f8: 2 ** 53 + 2 })
      .returning(["i4", "i8", "f8"])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({
      i4: 7,
      i8: 1152921504606846976n,
      f8: 9007199254740994,
    });
  });
});

describe("a Date", () => {
  test("of a year past 9999 or before 1 goes into a timestamp and a date as the time it is", async () => {
    const future = new Date(Date.UTC(10_000, 0, 2, 3, 4, 5));
    const ides = new Date("-000043-03-15T12:00:00.000Z");
    const { rows } = await sql`
      select set_config('TimeZone', 'UTC', true),
        ${future}::timestamptz::text as instant, ${future}::timestamp::text as wall,
        ${future}::date::text as day, ${ides}::timestamptz::text as before,
        ${ides}::date::text as before_day`.execute(db);

    expect(rows).toEqual([
      {
        set_config: "UTC",
        instant: "10000-01-02 03:04:05+00",
        wall: "10000-01-02 03:04:05",
        day: "10000-01-02",
        before: "0044-03-15 12:00:00+00 BC",
        before_day: "0044-03-15 BC",
      },
    ]);
  });
});

describe("db", () => {
  test("is Kysely's own otherwise: its class, its getters, and what its methods make", async () => {
    expect(db).toBeInstanceOf(Kysely);
    expect(db.constructor).toBe(Kysely);
    expect(db.isTransaction).toBe(false);
    expect(db.withSchema("public")).toBeInstanceOf(Kysely);

    const { count } = await db
      .selectFrom("orders")
      .select(db.fn.countAll<bigint>().as("count"))
      .executeTakeFirstOrThrow();

    expect(count).toEqual(expect.any(BigInt));
  });
});

describe("a version of Bun", () => {
  test.each(["1.4.4", "1.4.10", "1.5.0", "2.0.0", "1.4.4-canary.20+c6da4a4d3"])(
    "%s runs the package",
    (version) => {
      expect(() => checkBun(version)).not.toThrow();
    },
  );

  test.each(["1.4.3", "1.4.3-canary.7", "1.3.14", "0.9.9", ""])(
    "%j is refused, by its version",
    (version) => {
      expect(() => checkBun(version)).toThrow(
        new Error(
          `@tetsujs/sql needs Bun 1.4.4 or later, and this is Bun ${version}`,
        ),
      );
    },
  );

  test("this one runs it", () => {
    expect(() => checkBun(Bun.version)).not.toThrow();
  });
});
