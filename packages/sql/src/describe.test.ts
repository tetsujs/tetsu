/**
 * Describing queries: which columns of a plan an outer join may leave NULL,
 * and, against a real Postgres, what each query is typed as — its columns
 * by their tables, their joins and their markers, its parameters by their
 * types — and how a query Postgres refuses is told, where it is in its
 * file.
 *
 * @module
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { SQL } from "bun";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import type { Lookup, TsType } from "./catalog.ts";
import { readCatalog } from "./catalog.ts";
import { clientOf } from "./client.ts";
import type { DescribedQuery } from "./describe.ts";
import { describeQueries, planNullables } from "./describe.ts";
import { parseQuery, QueryFileError } from "./query-files.ts";
import { Wire } from "./wire.ts";

setDefaultTimeout(DATABASE_MS);

const { sql, url } = testDatabase();

let wire: Wire;
let lookup: Lookup;

beforeAll(async () => {
  await sql.unsafe(`
    create type status as enum ('new', 'paid');
    create domain note as text not null;
    create domain size as text check (value in ('s', 'm'));
    create domain shade as text check (value in ('dark', 'light'));
    create extension if not exists hstore;
    create table customers (
      id int8 primary key,
      email text not null,
      name text,
      size size
    );
    create table orders (
      id int8 primary key,
      customer_id int8 references customers,
      total numeric(10, 2) not null,
      status status not null default 'new',
      channel text not null check (channel in ('web', 'shop')),
      history status[],
      note note
    );
    create table items (order_id int8 not null, sku text not null);
    create table events (id int8 not null, at timestamptz not null)
      partition by range (at);
    create table events_2026 partition of events
      for values from ('2026-01-01') to ('2027-01-01');
    create table card_payments (
      id int8 primary key,
      status text not null check (status in ('authorized', 'captured'))
    );
    create table bank_payments (
      id int8 primary key,
      status text not null check (status in ('pending', 'settled'))
    );
    create view payments as
      select id, status from card_payments
      union all select id, status from bank_payments;
    create table categories (name text primary key);
    create table products (
      id int8 primary key,
      category text not null check (category in ('books', 'toys'))
    );
    create view live_orders as select * from orders where channel <> 'phone';
    create table tickets (
      id int8 not null,
      state text not null check (state in ('open', 'closed')),
      level int4 not null check (level in (1, 2))
    ) partition by list (state);
    create table tickets_open partition of tickets for values in ('open');
    create table tickets_closed partition of tickets for values in ('closed');
  `);
  lookup = (await readCatalog(sql, "public.migrations")).lookup;
  wire = await Wire.connect(clientOf(url));
});

afterAll(async () => {
  await wire.end();
});

/** The query of `source`, described. */
async function describeOne(source: string): Promise<DescribedQuery> {
  const [query] = await describeQueries(
    wire,
    [parseQuery("q.sql", "q", source)],
    lookup,
  );

  if (query === undefined) {
    throw new Error("the query was not described");
  }

  return query;
}

/** A type, as the file of queries writes it, for a test to read. */
function text(type: TsType): string {
  switch (type.kind) {
    case "keyword":
    case "alias":
      return type.name;
    case "union":
      return type.members.map(text).join(" | ");
    case "array":
      return `${type.readonly ? "readonly " : ""}(${text(type.element)})[]`;
  }
}

/** The columns of `source`, each as its name, its type and whether it may be NULL. */
async function columns(source: string): Promise<string[]> {
  const { fields } = await describeOne(source);

  return (fields ?? []).map(
    (field) =>
      `${field.name}: ${text(field.values.reads)}${field.nullable ? " | null" : ""}`,
  );
}

/** What describing the queries of `sources` throws, by line. */
async function problems(
  sources: Readonly<Record<string, string>>,
): Promise<string[]> {
  const error = await describeQueries(
    wire,
    Object.entries(sources).map(([name, source]) =>
      parseQuery(`${name}.sql`, name, source),
    ),
    lookup,
  ).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(QueryFileError);

  return (error as Error).message.split("\n");
}

/** A node of a plan, of the shape `EXPLAIN (VERBOSE, FORMAT JSON)` writes. */
function node(
  output: readonly string[] | undefined,
  shape: {
    type?: string;
    join?: string;
    side?: string;
    scans?: string;
    sets?: unknown;
    plans?: readonly object[];
  } = {},
): object {
  const [alias, relation] = shape.scans?.split(" of ") ?? [];

  return {
    "Node Type":
      shape.type ?? (shape.join === undefined ? "Seq Scan" : "Hash Join"),
    ...(shape.join === undefined ? {} : { "Join Type": shape.join }),
    ...(shape.side === undefined ? {} : { "Parent Relationship": shape.side }),
    ...(relation === undefined
      ? {}
      : { "Relation Name": relation, Schema: "public", Alias: alias }),
    ...(shape.sets === undefined ? {} : { "Grouping Sets": shape.sets }),
    ...(output === undefined ? {} : { Output: output }),
    ...(shape.plans === undefined ? {} : { Plans: shape.plans }),
  };
}

/** A plan of `top`, as `EXPLAIN (FORMAT JSON)` gives one. */
const planOf = (top: object) => [{ Plan: top }];

/** A left join of orders `o` and customers `c`, as a join of `type`, `c` on `side`. */
function join(type: string, side: string) {
  const other = side === "Inner" ? "Outer" : "Inner";

  return planOf(
    node(["o.id", "c.email"], {
      join: type,
      plans: [
        node(["c.id", "c.email"], { side, scans: "c of customers" }),
        node(["o.id", "o.customer_id"], { side: other, scans: "o of orders" }),
      ],
    }),
  );
}

describe("the columns a plan may make NULL", () => {
  test("are none in a plan of no outer join, whatever it outputs", () => {
    expect(
      planNullables(
        planOf(
          node(undefined, {
            type: "Append",
            plans: [
              node(["e_1.id"], { side: "Member", scans: "e_1 of events_1" }),
            ],
          }),
        ),
        1,
      ),
    ).toEqual(new Set());
    expect(planNullables(join("Inner", "Inner"), 2)).toEqual(new Set());
  });

  test("are the inner side's of a left join, and the outer side's of a right join, as Postgres plans a left join swapped", () => {
    expect(planNullables(join("Left", "Inner"), 2)).toEqual(new Set([1]));
    expect(planNullables(join("Right", "Outer"), 2)).toEqual(new Set([1]));
  });

  test("are the inner side's of an anti join, and the outer side's of a right anti one, which give their rows of no match", () => {
    expect(planNullables(join("Anti", "Inner"), 2)).toEqual(new Set([1]));
    expect(planNullables(join("Right Anti", "Outer"), 2)).toEqual(new Set([1]));
    expect(planNullables(join("Semi", "Inner"), 2)).toEqual(new Set());
  });

  test("are both sides' of a full join", () => {
    expect(planNullables(join("Full", "Inner"), 2)).toEqual(new Set([0, 1]));
  });

  test("under an outer join are those no scan reads outside its nullable side, as a CTE's", () => {
    const plan = planOf(
      node(["x.id", "x.email", "o.id"], {
        type: "Nested Loop",
        join: "Inner",
        plans: [
          node(["x.id", "x.email"], {
            type: "CTE Scan",
            side: "Outer",
            plans: [
              node(["o.id", "c.email"], {
                join: "Left",
                side: "InitPlan",
                plans: [
                  node(["o.id"], { side: "Outer", scans: "o of orders" }),
                  node(["c.email"], { side: "Inner", scans: "c of customers" }),
                ],
              }),
            ],
          }),
          node(["o.id"], { side: "Inner", scans: "o of orders" }),
        ],
      }),
    );

    expect(planNullables(plan, 3)).toEqual(new Set([0, 1]));
  });

  test("written by a statement are not those of the table it writes, but those of a nullable side", () => {
    const plan = planOf(
      node(["o.id", "c.email", "o.total"], {
        type: "ModifyTable",
        scans: "o of orders",
        plans: [
          node(["c.email", "o.ctid"], {
            join: "Left",
            side: "Outer",
            plans: [
              node(["o.ctid"], { side: "Outer", scans: "o of orders" }),
              node(["c.email"], { side: "Inner", scans: "c of customers" }),
            ],
          }),
        ],
      }),
    );

    expect(planNullables(plan, 3)).toEqual(new Set([1]));
  });

  test("returned by a statement from before or after its row was written are those of no table read", () => {
    expect(
      planNullables(
        planOf(
          node(["old.email", "new.email", "customers.id"], {
            type: "ModifyTable",
            scans: "customers of customers",
            plans: [
              node(["1000", "'a'::text"], { type: "Result", side: "Outer" }),
            ],
          }),
        ),
        3,
      ),
    ).toEqual(new Set([0, 1]));
  });

  test("are a column a nullable side outputs, though a scan elsewhere reads the same text", () => {
    const plan = planOf(
      node(["c.email"], {
        join: "Left",
        plans: [
          node(["c.email"], { side: "Outer", scans: "c of customers" }),
          node(["c.email"], { side: "Inner", scans: "c of contacts" }),
        ],
      }),
    );

    expect(planNullables(plan, 1)).toEqual(new Set([0]));
  });

  test("cannot be told under grouping sets, or when the plan's outputs are not the columns", () => {
    expect(
      planNullables(
        planOf(
          node(["status", "count(*)"], {
            type: "Aggregate",
            sets: [
              { "Hash Keys": [["orders.status"]] },
              { "Group Keys": [[]] },
            ],
            plans: [
              node(["status"], { side: "Outer", scans: "orders of orders" }),
            ],
          }),
        ),
        2,
      ),
    ).toBe(undefined);
    expect(planNullables(join("Left", "Inner"), 3)).toBe(undefined);
    expect(planNullables(null, 1)).toBe(undefined);
    expect(planNullables([], 1)).toBe(undefined);
  });
});

describe("a column a query returns", () => {
  test("taken from a table is as NULL as the table's column, typed by the file's types", async () => {
    expect(
      await columns(
        "select id, customer_id, total, status, channel, history from orders",
      ),
    ).toEqual([
      "id: bigint",
      "customer_id: bigint | null",
      "total: string",
      "status: Status",
      "channel: OrdersChannel",
      "history: string | null",
    ]);
  });

  test("on the side of a left join, of a right join or of a full join that may find no row is NULL", async () => {
    expect(
      await columns(
        "select o.id, c.email from orders o left join customers c on c.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "select o.id, c.email from customers c right join orders o on c.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "select o.id, c.email from orders o full join customers c on c.id = o.customer_id",
      ),
    ).toEqual(["id: bigint | null", "email: string | null"]);
    expect(
      await columns(
        "select o.id, c.email from orders o join customers c on c.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "email: string"]);
  });

  test("of a subquery, a CTE or a lateral join on the side that may find no row is NULL", async () => {
    expect(
      await columns(
        "select o.id, x.email from orders o left join (select id, email from customers limit 5) x on x.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "with c as (select id, email from customers) select o.id, c.email from orders o left join c on c.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "select o.id, l.sku from orders o left join lateral (select sku from items i where i.order_id = o.id limit 1) l on true",
      ),
    ).toEqual(["id: bigint", "sku: string | null"]);
  });

  test("under an outer join is NULL unless the plan reads it from its table, as it does not a materialized CTE's", async () => {
    expect(
      await columns(
        "with x as materialized (select o.id, c.email from orders o left join customers c on c.id = o.customer_id) select x.id, x.email from x",
      ),
    ).toEqual(["id: bigint | null", "email: string | null"]);
    expect(
      await columns(
        "select o.id, p.id as pid from orders o left join orders p on p.id = o.customer_id",
      ),
    ).toEqual(["id: bigint", "pid: bigint | null"]);
    expect(
      await columns(
        "update orders o set total = 0 from orders p left join customers c on c.id = p.customer_id where p.id = o.id returning o.id, c.email",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "with x as materialized (select c.id, c.email from orders p left join customers c on c.id = p.customer_id) update orders o set total = 0 from x where x.id = o.customer_id returning o.id, x.email",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
  });

  test("on the side of an anti join, Postgres's plan of a left join that keeps the rows that find no match, is NULL", async () => {
    expect(
      await columns(
        "select o.id, c.email, c.id as cid from orders o left join customers c on c.id = o.customer_id where c.id is null",
      ),
    ).toEqual(["id: bigint", "email: string | null", "cid: bigint | null"]);
    expect(
      await columns(
        "select o.id, c.email from customers c right join orders o on c.id = o.customer_id where c.id is null",
      ),
    ).toEqual(["id: bigint", "email: string | null"]);
    expect(
      await columns(
        "select x.email from (select c.email from orders o left join customers c on c.id = o.customer_id where c.id is null offset 0) x",
      ),
    ).toEqual(["email: string | null"]);
  });

  test("under an outer join is told apart from what the plan outputs after the columns, to sort by", async () => {
    expect(
      await columns(
        "select o.id from orders o left join customers c on c.id = o.customer_id order by c.email",
      ),
    ).toEqual(["id: bigint"]);
  });

  test("returned from before or after its row was written may be NULL, from Postgres 18 on", async () => {
    const [{ version }] =
      await sql`select current_setting('server_version_num')::int as version`;

    if (version < 180000) {
      return;
    }

    expect(
      await columns(
        "insert into customers (id, email) values (1000, 'a') on conflict (id) do update set email = 'b' returning old.email as before, new.email as after, id",
      ),
    ).toEqual(["before: string | null", "after: string | null", "id: bigint"]);
    expect(
      await columns(
        "delete from customers where id = 1000 returning new.email as after",
      ),
    ).toEqual(["after: string | null"]);
  });

  test("of a plan of no outer join is as NULL as its column, of a partitioned table too", async () => {
    expect(await columns("select id, at from events")).toEqual([
      "id: bigint",
      "at: Date",
    ]);
  });

  test("grouped by grouping sets is NULL", async () => {
    expect(
      await columns(
        "select status, count(*) as n from orders group by rollup (status)",
      ),
    ).toEqual(["status: Status | null", "n: bigint | null"]);
  });

  test("grouped over a left join is NULL on the side that may find no row, and an aggregate is NULL", async () => {
    expect(
      await columns(
        "select c.email, count(o.id) as orders, max(o.total) as top from customers c left join orders o on o.customer_id = c.id group by c.email",
      ),
    ).toEqual(["email: string", "orders: bigint | null", "top: string | null"]);
  });

  test("of an expression, a union or a table the file does not describe is NULL", async () => {
    expect(
      await columns(
        "select 1 as one, now() as at, id + 1 as next from orders union all select 2, now(), 3",
      ),
    ).toEqual(["one: number | null", "at: Date | null", "next: bigint | null"]);
    expect(await columns("select id, at from events_2026")).toEqual([
      "id: bigint | null",
      "at: Date | null",
    ]);
    expect(await columns("select relname from pg_class limit 1")).toEqual([
      "relname: string | null",
    ]);
  });

  test("marked ! is never NULL, and marked ? may be, whatever the rest says", async () => {
    expect(
      await columns(
        'select count(*) as "n!", o.id as "id?", c.email as "email!" from orders o left join customers c on c.id = o.customer_id group by o.id, c.email',
      ),
    ).toEqual(["n: bigint", "id: bigint | null", "email: string"]);
  });

  test("of a query whose plan Postgres refuses is NULL, as the plan cannot tell", async () => {
    const bigint: TsType = { kind: "keyword", name: "bigint" };
    const values = { reads: bigint, writes: bigint };
    const refusing = {
      prepare: async () => ({
        parameters: [],
        fields: [{ name: "id", type: 20, modifier: -1, table: 1, column: 1 }],
      }),
      query: async (text: string) => {
        if (text.startsWith("explain")) {
          throw new SQL.PostgresError("cannot plan", {
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: "0A000",
          });
        }

        return [];
      },
    } as unknown as Wire;
    const [query] = await describeQueries(
      refusing,
      [parseQuery("q.sql", "q", "select id from t")],
      {
        column: () => ({ values, nullable: false }),
        type: () => ({ values, literal: undefined, base: 20 }),
        allowed: () => undefined,
      },
    );

    expect(query?.fields).toEqual([{ name: "id", values, nullable: true }]);
  });

  test("of a query whose parameters Postgres counts otherwise than the file is refused", async () => {
    const counting = {
      prepare: async () => ({ parameters: [], fields: null }),
      query: async () => [],
    } as unknown as Wire;
    const error = await describeQueries(
      counting,
      [parseQuery("q.sql", "q", "update t set a = :a")],
      lookup,
    ).catch((failure: unknown) => failure);

    expect(error).toEqual(
      new QueryFileError(
        "q.sql: Postgres finds 0 parameters where the file names 1: it reads a string, a quoted name or a comment of the file otherwise",
      ),
    );
  });

  test("of a statement Postgres cannot plan is NULL", async () => {
    expect(await columns("show search_path")).toEqual([
      "search_path: string | null",
    ]);
  });

  test("of a statement that returns no rows is none", async () => {
    expect(
      await describeOne("update orders set total = 0 where id = :id"),
    ).toMatchObject({ fields: null });
    expect(
      await columns(
        "insert into items values (1, 'a') returning order_id, sku",
      ),
    ).toEqual(["order_id: bigint", "sku: string"]);
  });
});

describe("a parameter", () => {
  /** The parameters of `source`, each as its name, its type, and how its arrays are written. */
  async function parameters(source: string): Promise<string[]> {
    const query = await describeOne(source);

    return query.parameters.map(
      (parameter) =>
        `${parameter.name}${parameter.nullable ? "?" : ""}: ${text(parameter.values.writes)}${parameter.literal === undefined ? "" : ` (${parameter.literal})`}`,
    );
  }

  test("is typed as its type is written, an array with how it is written", async () => {
    expect(
      await parameters(
        "select * from orders where status = any(:statuses) and id = :id and total > :total and channel = :channel and note = :note?",
      ),
    ).toEqual([
      "statuses: readonly (Status)[] (,)",
      "id: bigint",
      "total: string",
      "channel: string",
      "note?: string",
    ]);
    expect(
      await parameters(
        "select :documents::jsonb[] as a, :boxes::box[] as b, :at::timestamptz as c, :size::size as d, :pairs::hstore as e",
      ),
    ).toEqual([
      "documents: readonly (object | null)[] (json)",
      "boxes: readonly (string | null)[] (;)",
      "at: Date | string",
      "size: Size",
      "pairs: unknown",
    ]);
  });

  test("of a domain no column holds is typed as its type, as the file of types names no alias for it", async () => {
    expect(await parameters("select :shade::shade as s")).toEqual([
      "shade: string",
    ]);
  });

  test("of a domain that is not null leaves the query to be planned, as of the domain's type, query after query", async () => {
    const source =
      "select o.id, c.email from orders o left join customers c on c.id = o.customer_id where o.note = :note::note";
    const described = await describeQueries(
      wire,
      [parseQuery("a.sql", "a", source), parseQuery("b.sql", "b", source)],
      lookup,
    );

    for (const { fields } of described) {
      expect(fields?.map((field) => [field.name, field.nullable])).toEqual([
        ["id", false],
        ["email", true],
      ]);
    }
  });
});

describe("a query Postgres refuses", () => {
  test("is told where it is in its file, its parameters by name", async () => {
    expect(
      await problems({
        unknown: "select id,\n  :customerId as c, qqqqqq\nfrom orders",
        syntax: "selec 1",
        untyped: "select :value is null as v",
      }),
    ).toEqual([
      'unknown.sql:2:21: column "qqqqqq" does not exist',
      'syntax.sql:1:1: syntax error at or near "selec"',
      "untyped.sql: could not determine data type of parameter :value (hint: give it a type with a cast, as :value::text)",
    ]);
  });

  test("of more than one statement is told so", async () => {
    expect(await problems({ two: "select 1; select 2" })).toEqual([
      "two.sql: holds more than one statement: a file holds one query",
    ]);
  });

  test("is told with the others, past the queries described", async () => {
    expect(
      await problems({
        fine: "select 1 as one",
        unnamed: "select 1 + 1",
        twice: "select 1 as a, 2 as a",
        marked: 'select 1 as "a!", 2 as b, "c?"',
        nothing: "select from orders",
      }),
    ).toEqual([
      "unnamed.sql: returns a column with no name: name it with as",
      "twice.sql: returns two columns named a: name them apart with as",
      'marked.sql:1:27: column "c" does not exist',
      "nothing.sql: returns rows of no columns: return some, or none at all",
    ]);
    expect(await problems({ alias: 'select o.id from orders "o!"' })).toEqual([
      'alias.sql: marks "o!", which is not a column the query returns',
    ]);
  });
});

describe("a literal a query compares a column with", () => {
  test("outside the list the column's checks allow refuses the file, where the file writes it", async () => {
    expect(
      await problems({
        typo: "select id from orders\nwhere channel = 'wbe'",
        listed: "select id from orders where channel in ('web', 'shpo')",
        kept: "select id from customers where size <> 'xl'",
        updated: "update orders set total = 1 where channel = 'shpo'",
      }),
    ).toEqual([
      "typo.sql:2:17: orders.channel never holds 'wbe', only 'web', 'shop'",
      "listed.sql:1:48: orders.channel never holds 'shpo', only 'web', 'shop'",
      "kept.sql:1:40: customers.size never holds 'xl', only 's', 'm'",
      "updated.sql:1:45: orders.channel never holds 'shpo', only 'web', 'shop'",
    ]);
  });

  test("outside an enum's labels, through a cast to text, refuses the file too", async () => {
    expect(
      await problems({
        cast: "select id from orders where status::text = 'nwe'",
      }),
    ).toEqual([
      "cast.sql:1:44: orders.status never holds 'nwe', only 'new', 'paid'",
    ]);
  });

  test("that one of the tables a union reads may hold passes, and one none of them holds is refused at each", async () => {
    expect(
      await columns(
        "select id from payments where status in ('captured', 'settled')",
      ),
    ).toEqual(["id: bigint | null"]);
    expect(
      await problems({
        union: "select id from payments where status <> 'setled'",
      }),
    ).toEqual([
      "union.sql:1:41: card_payments.status never holds 'setled', only 'authorized', 'captured'",
      "union.sql:1:41: bank_payments.status never holds 'setled', only 'pending', 'settled'",
    ]);
  });

  test("that a join compares with a column of its own passes, though the plan compares it with the other", async () => {
    expect(
      await columns(
        "select c.name, p.id from categories c left join products p on p.category = c.name where c.name = 'garden'",
      ),
    ).toEqual(["name: string", "id: bigint | null"]);
    expect(
      await columns(
        "select c.name from categories c where c.name = 'garden' and not exists (select from products p where p.category = c.name)",
      ),
    ).toEqual(["name: string"]);
  });

  test("that a view the query reads holds, not the file, is left to the view's migration", async () => {
    expect(await columns("select id from live_orders where id = 1")).toEqual([
      "id: bigint | null",
    ]);
  });

  test("compared with a column of a partitioned table is held to the table's list, and an integer is told where it is", async () => {
    expect(
      await problems({
        parts: "select id from tickets\nwhere state <> 'opne' and level <> 3",
      }),
    ).toEqual([
      "parts.sql:2:16: tickets.state never holds 'opne', only 'open', 'closed'",
      "parts.sql:2:36: tickets.level never holds 3, only 1, 2",
    ]);
  });

  test("that the column may hold, or that is a parameter, passes", async () => {
    expect(
      await columns(
        "select id from orders where channel in ('web', 'shop') and channel <> :other",
      ),
    ).toEqual(["id: bigint"]);
  });
});
