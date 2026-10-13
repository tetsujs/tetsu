/**
 * Where the plugin writes a JavaScript array as a literal, held on the
 * queries Kysely compiles: where a query says the array goes to a column
 * of arrays, and nowhere else. What Postgres makes of the literals is held
 * by `database.test.ts`.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Compilable, Kysely as KyselyType } from "kysely";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { ArraysPlugin } from "./arrays.ts";

interface Database {
  orders: {
    id: bigint;
    tags: string[] | null;
    boxes: string[] | null;
    payload: unknown;
    note: string | null;
    documents: unknown[] | null;
  };
  items: { order_id: bigint; tags: string[] | null; name: string };
  logs: { order_id: bigint; tags: unknown };
  "billing.invoices": { id: bigint; codes: string[] | null };
}

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely: KyselyType<unknown>) =>
      new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  plugins: [
    new ArraysPlugin({
      orders: { tags: ",", boxes: ";", documents: "json" },
      items: { tags: "," },
      "billing.invoices": { codes: "," },
    }),
  ],
});

/** The SQL and the parameters a query compiles to. */
function compiled(query: Compilable): [string, readonly unknown[]] {
  const { sql: text, parameters } = query.compile();

  return [text, parameters];
}

describe("an insert", () => {
  test("writes an array to a column of arrays as a literal, in each row", () => {
    expect(
      compiled(
        db.insertInto("orders").values([
          { id: 1n, tags: ["a", "b"], payload: ["kept"] },
          { id: 2n, tags: [] },
        ]),
      ),
    ).toEqual([
      'insert into "orders" ("id", "tags", "payload") values ($1, $2, $3), ($4, $5, default)',
      [1n, '{"a","b"}', ["kept"], 2n, "{}"],
    ]);
  });

  test("writes it among values that are expressions too", () => {
    expect(
      compiled(
        db.insertInto("orders").values({
          id: 1n,
          tags: ["a"],
          note: sql<string>`upper(${"x"})`,
        }),
      ),
    ).toEqual([
      'insert into "orders" ("id", "tags", "note") values ($1, $2, upper($3))',
      [1n, '{"a"}', "x"],
    ]);
  });

  test("separates elements by the column's delimiter", () => {
    expect(
      compiled(
        db.insertInto("orders").values({
          id: 1n,
          boxes: ["(1,1),(0,0)", "(2,2),(1,1)"],
        }),
      )[1],
    ).toEqual([1n, '{"(1,1),(0,0)";"(2,2),(1,1)"}']);
  });

  test("writes an array of arrays as one of more dimensions, and an array of json as the JSON of its elements", () => {
    expect(
      compiled(
        db.insertInto("orders").values({
          id: 1n,
          tags: [["a", "b"], ["c"]] as never,
          documents: [[1, 2], { a: 1 }, "s"],
        }),
      )[1],
    ).toEqual([1n, '{{"a","b"},{"c"}}', '{"[1,2]","{\\"a\\":1}","\\"s\\""}']);
  });

  test("leaves an array for a column of jsonb as it is, for Bun to write as JSON", () => {
    expect(
      compiled(db.insertInto("orders").values({ id: 1n, payload: [1, 2] }))[1],
    ).toEqual([1n, [1, 2]]);
  });

  test("writes the arrays of an upsert's update, and of the insert", () => {
    expect(
      compiled(
        db
          .insertInto("orders")
          .values({ id: 1n, tags: ["a"] })
          .onConflict((conflict) =>
            conflict
              .column("id")
              .doUpdateSet({ tags: ["b"], payload: { set: true } }),
          ),
      ),
    ).toEqual([
      'insert into "orders" ("id", "tags") values ($1, $2) on conflict ("id") do update set "tags" = $3, "payload" = $4',
      [1n, '{"a"}', '{"b"}', { set: true }],
    ]);
  });

  test("into a relation of another schema finds its columns by its key", () => {
    expect(
      compiled(
        db.insertInto("billing.invoices").values({ id: 1n, codes: ["x"] }),
      )[1],
    ).toEqual([1n, '{"x"}']);
  });

  test("into a table named with a schema of withSchema() finds the same columns, and public is no schema", () => {
    const billing = db.withSchema("billing") as unknown as KyselyType<{
      invoices: { id: bigint; codes: string[] };
    }>;
    const public_ = db.withSchema("public");

    expect(
      compiled(billing.insertInto("invoices").values({ id: 1n, codes: ["x"] })),
    ).toEqual([
      'insert into "billing"."invoices" ("id", "codes") values ($1, $2)',
      [1n, '{"x"}'],
    ]);
    expect(
      compiled(public_.insertInto("orders").values({ id: 1n, tags: ["a"] }))[1],
    ).toEqual([1n, '{"a"}']);
  });

  test("of rows a select makes writes nothing of its own", () => {
    expect(
      compiled(
        db
          .insertInto("orders")
          .columns(["id", "tags"])
          .expression((eb) =>
            eb.selectFrom("items").select(["order_id", "tags"]),
          ),
      ),
    ).toEqual([
      'insert into "orders" ("id", "tags") select "order_id", "tags" from "items"',
      [],
    ]);
  });
});

describe("an update", () => {
  test("writes an array it sets to a column of arrays as a literal", () => {
    expect(
      compiled(
        db
          .updateTable("orders")
          .set({ tags: ["a"], payload: ["kept"] })
          .where("id", "=", 1n),
      ),
    ).toEqual([
      'update "orders" set "tags" = $1, "payload" = $2 where "id" = $3',
      ['{"a"}', ["kept"], 1n],
    ]);
  });

  test("sets by a column name and value, and of an aliased table", () => {
    expect(compiled(db.updateTable("orders").set("tags", ["a"]))[1]).toEqual([
      '{"a"}',
    ]);
    expect(
      compiled(db.updateTable("orders as o").set({ tags: ["a"] }))[1],
    ).toEqual(['{"a"}']);
  });

  test("from another table sets the columns of its own", () => {
    expect(
      compiled(
        db
          .updateTable("items")
          .from("orders")
          .set({ tags: ["i"] })
          .whereRef("items.order_id", "=", "orders.id"),
      )[1],
    ).toEqual(['{"i"}']);
  });
});

describe("a merge", () => {
  test("writes the arrays of its update and of its insert to its table's columns", () => {
    expect(
      compiled(
        db
          .mergeInto("orders as t")
          .using("items as s", "s.order_id", "t.id")
          .whenMatched()
          .thenUpdateSet({ tags: ["m"] })
          .whenNotMatched()
          .thenInsertValues({ id: 9n, tags: ["n"] }),
      ),
    ).toEqual([
      'merge into "orders" as "t" using "items" as "s" on "s"."order_id" = "t"."id" when matched then update set "tags" = $1 when not matched then insert ("id", "tags") values ($2, $3)',
      ['{"m"}', 9n, '{"n"}'],
    ]);
  });
});

describe("a comparison with a column of arrays", () => {
  test("writes an array as a literal", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where("tags", "@>", (eb) => eb.val(["a", "b"])),
      ),
    ).toEqual(['select "id" from "orders" where "tags" @> $1', ['{"a","b"}']]);
  });

  test("makes the list Kysely builds of an array one literal again", () => {
    expect(
      compiled(
        db.selectFrom("orders").select("id").where("tags", "&&", ["a", "b"]),
      ),
    ).toEqual(['select "id" from "orders" where "tags" && $1', ['{"a","b"}']]);
    expect(
      compiled(db.selectFrom("orders").select("id").where("tags", "=", [])),
    ).toEqual(['select "id" from "orders" where "tags" = $1', ["{}"]]);
  });

  test("of in keeps the list, each array in it a literal", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where("tags", "in", [["a"], ["b"]] as unknown as string[]),
      ),
    ).toEqual([
      'select "id" from "orders" where "tags" in ($1, $2)',
      ['{"a"}', '{"b"}'],
    ]);
  });

  test("finds the column by its alias, its table and its schema, in a join too", () => {
    expect(
      compiled(
        db
          .selectFrom("orders as o")
          .innerJoin("items", "items.order_id", "o.id")
          .select("o.id")
          .where("o.tags", "@>", (eb) => eb.val(["a"]))
          .where("items.tags", "@>", (eb) => eb.val(["b"])),
      )[1],
    ).toEqual(['{"a"}', '{"b"}']);
    expect(
      compiled(
        db
          .selectFrom("billing.invoices")
          .select("id")
          .where("billing.invoices.codes", "@>", (eb) => eb.val(["c"])),
      )[1],
    ).toEqual(['{"c"}']);
  });

  test("finds it on either side", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) => eb(eb.val(["a"]), "<@", eb.ref("tags"))),
      ),
    ).toEqual(['select "id" from "orders" where $1 <@ "tags"', ['{"a"}']]);
  });

  test("of a delete writes an array as a literal", () => {
    expect(
      compiled(
        db.deleteFrom("orders").where("tags", "@>", (eb) => eb.val(["x"])),
      ),
    ).toEqual(['delete from "orders" where "tags" @> $1', ['{"x"}']]);
  });
});

describe("an array left as it is", () => {
  test("compared with a column of jsonb", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) =>
            eb(eb.ref("payload"), "@>", eb.val([{ a: 1 }]) as never),
          ),
      )[1],
    ).toEqual([[{ a: 1 }]]);
  });

  test("compared with a column of jsonb its relation qualifies, though another relation's column of that name holds arrays", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .innerJoin("logs", "logs.order_id", "orders.id")
          .select("orders.id")
          .where((eb) =>
            eb(eb.ref("logs.tags"), "@>", eb.val([{ a: 1 }]) as never),
          ),
      )[1],
    ).toEqual([[{ a: 1 }]]);
  });

  test("compared with a column of an outer query, which the subquery does not name", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("items")
                .select("name")
                .where("orders.tags", "@>", (inner) => inner.val(["x"])),
            ),
          ),
      )[1],
    ).toEqual([["x"]]);
  });

  test("compared with a CTE's column, though the CTE has a table's name", () => {
    const query = db
      .with("orders", (qb) =>
        qb.selectFrom("items").select(["order_id as id", "name as tags"]),
      )
      .selectFrom("orders")
      .select("id")
      .where((eb) => eb(eb.ref("tags"), "=", eb.val(["x"]) as never));

    expect(compiled(query)[1]).toEqual([["x"]]);
  });

  test("compared with a column of a subquery", () => {
    expect(
      compiled(
        db
          .selectFrom((eb) =>
            eb.selectFrom("orders").select(["id", "payload as tags"]).as("o"),
          )
          .select("o.id")
          .where((eb) => eb(eb.ref("o.tags"), "=", eb.val(["x"]))),
      )[1],
    ).toEqual([["x"]]);
  });

  test("in raw SQL, and as the argument of another function", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where(sql<boolean>`tags @> ${["raw"]}`),
      )[1],
    ).toEqual([["raw"]]);
    expect(
      compiled(
        db.updateTable("orders").set((eb) => ({
          tags: eb.fn<string[]>("array_cat", ["tags", eb.val(["x"])]),
        })),
      )[1],
    ).toEqual([["x"]]);
  });
});

describe("any() and all()", () => {
  test("take an array as a literal, as nothing else is their argument", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) => eb("id", "=", eb.fn.any(eb.val([1n, 2n])))),
      ),
    ).toEqual([
      'select "id" from "orders" where "id" = any($1)',
      ['{"1","2"}'],
    ]);
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) =>
            eb("note", "<>", eb.fn<string>("all", [eb.val(["a"])])),
          ),
      )[1],
    ).toEqual(['{"a"}']);
  });

  test("of a column take it as it is", () => {
    expect(
      compiled(
        db
          .selectFrom("orders")
          .select("id")
          .where((eb) => eb(eb.val("a"), "=", eb.fn.any("tags"))),
      ),
    ).toEqual(['select "id" from "orders" where $1 = any("tags")', ["a"]]);
  });
});

test("a query that cannot be written leaves the transformer as it found it", () => {
  const plugin = new ArraysPlugin({ orders: { tags: "," } });
  const kysely = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (inner: KyselyType<unknown>) =>
        new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [plugin],
  });
  const stack = (plugin as unknown as { transformer: { nodeStack: unknown[] } })
    .transformer.nodeStack;

  expect(() =>
    kysely
      .insertInto("orders")
      .values({ id: 1n, tags: [new Date(Number.NaN) as never] })
      .compile(),
  ).toThrow(RangeError);
  expect(stack).toEqual([]);
});

test("a relation named as a property every object has has no columns of arrays", () => {
  const plain = db as unknown as KyselyType<{
    constructor: { tags: string[] };
  }>;

  expect(
    compiled(plain.insertInto("constructor").values({ tags: ["a"] }))[1],
  ).toEqual([["a"]]);
});
