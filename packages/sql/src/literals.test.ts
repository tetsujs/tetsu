/**
 * The literals a plan compares a column with, held to the values the
 * column may hold, as conditions read when `EXPLAIN VERBOSE` writes them:
 * which comparisons are read, and which are left alone because a literal
 * there is not certain to be outside.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Allowed } from "./literals.ts";
import { literalsOutside } from "./literals.ts";

/** The lists of the columns of these tests, by schema, relation and column. */
const LISTS: Readonly<Record<string, readonly (string | number)[]>> = {
  "public.tasks.status": ["pending", "done"],
  "public.tasks.kind": ["a", "b"],
  "public.orders.rank": [10, 20],
  "billing.invoices.state": ["open", "it's paid"],
};

const allowed: Allowed = (schema, relation, column) =>
  LISTS[`${schema}.${relation}.${column}`];

/** A scan of a relation, with the conditions of its node. */
interface Scan {
  readonly relation: string;
  readonly alias: string;
  readonly schema?: string;
  readonly conditions: Readonly<Record<string, string>>;
}

/** A plan of these scans, each a node under one above them. */
function plan(...scans: readonly Scan[]): unknown {
  return [
    {
      Plan: {
        "Node Type": "Append",
        Plans: scans.map((scan) => ({
          "Node Type": "Seq Scan",
          "Relation Name": scan.relation,
          Schema: scan.schema ?? "public",
          Alias: scan.alias,
          ...scan.conditions,
        })),
      },
    },
  ];
}

/** The literals outside, as `column value`, of a scan of `tasks` as `t`. */
function outsideTasks(filter: string): string[] {
  return literalsOutside(
    plan({ relation: "tasks", alias: "t", conditions: { Filter: filter } }),
    allowed,
  ).map(({ column, value }) => `${column} ${String(value)}`);
}

describe("a literal compared with a column of a list", () => {
  test("outside the list is found, with the values the column holds", () => {
    expect(
      literalsOutside(
        plan({
          relation: "tasks",
          alias: "t",
          conditions: { Filter: "(t.status = 'pendng'::text)" },
        }),
        allowed,
      ),
    ).toEqual([
      { column: "tasks.status", value: "pendng", allowed: ["pending", "done"] },
    ]);
  });

  test("inside the list is not", () => {
    expect(outsideTasks("(t.status = 'done'::text)")).toEqual([]);
  });

  test("is found on either side, with = and <>, in and or", () => {
    expect(
      outsideTasks(
        "(('pendng'::text = t.status) OR ((t.status <> 'dnoe'::text) AND (t.status = 'done'::text)))",
      ),
    ).toEqual(["tasks.status pendng", "tasks.status dnoe"]);
  });

  test("is found in the array of in and of not in, NULL left out, quoted elements read", () => {
    expect(
      outsideTasks(
        `((t.status = ANY ('{done,pendng}'::text[])) AND (t.status <> ALL ('{"on hold",NULL,"say \\"hi\\""}'::text[])))`,
      ),
    ).toEqual([
      "tasks.status pendng",
      "tasks.status on hold",
      'tasks.status say "hi"',
    ]);
  });

  test("is found through a cast of the column to text, as of a varchar", () => {
    expect(outsideTasks("((t.kind)::text = 'c'::text)")).toEqual([
      "tasks.kind c",
    ]);
  });

  test("of integers is found as an integer, bare or cast", () => {
    expect(
      literalsOutside(
        plan({
          relation: "orders",
          alias: "o",
          conditions: {
            Filter:
              "((o.rank = 15) OR (o.rank = '-3'::integer) OR (o.rank = 20) OR (o.rank = ANY ('{10,30}'::integer[])))",
          },
        }),
        allowed,
      ).map(({ value }) => value),
    ).toEqual([15, -3, 30]);
  });

  test("is unquoted, in a schema of its own, by a quoted alias", () => {
    expect(
      literalsOutside(
        plan({
          relation: "invoices",
          alias: "I",
          schema: "billing",
          conditions: {
            Filter:
              "((\"I\".state = 'it''s due'::text) OR (\"I\".state = 'it''s paid'::text))",
          },
        }),
        allowed,
      ),
    ).toEqual([
      {
        column: "billing.invoices.state",
        value: "it's due",
        allowed: ["open", "it's paid"],
      },
    ]);
  });

  test("is found once, though an index condition and its recheck both hold it", () => {
    expect(
      literalsOutside(
        plan({
          relation: "tasks",
          alias: "t",
          conditions: {
            "Index Cond": "(t.status = 'pendng'::text)",
            "Recheck Cond": "(t.status = 'pendng'::text)",
          },
        }),
        allowed,
      ),
    ).toHaveLength(1);
  });

  test("is found by the alias of its own scan, in a join of a table with itself", () => {
    expect(
      literalsOutside(
        plan(
          {
            relation: "tasks",
            alias: "t",
            conditions: { Filter: "(t.status = 'done'::text)" },
          },
          {
            relation: "orders",
            alias: "t_1",
            conditions: { Filter: "(t_1.rank = 30)" },
          },
        ),
        allowed,
      ).map(({ column, value }) => `${column} ${String(value)}`),
    ).toEqual(["orders.rank 30"]);
  });
});

describe("a comparison left alone", () => {
  test.each([
    ["with a parameter", "(t.status = $1)"],
    ["with another column", "(t.status = t.kind)"],
    ["of a function of the column", "(lower(t.status) = 'x'::text)"],
    ["of the column cast to another type", "((t.status)::integer = 3)"],
    ["of a column of no list", "(t.note = 'x'::text)"],
    ["of a relation the plan does not scan", "(c.status = 'x'::text)"],
    ["with an array of arrays", "(t.status = ANY ('{{x}}'::text[]))"],
    ["with an expression", "(t.status = ('x'::text || 'y'::text))"],
  ])("%s", (_, filter) => {
    expect(outsideTasks(filter)).toEqual([]);
  });

  test("with a fraction, for a column of integers", () => {
    expect(
      literalsOutside(
        plan({
          relation: "orders",
          alias: "o",
          conditions: { Filter: "((o.rank)::numeric = 15.5)" },
        }),
        allowed,
      ),
    ).toEqual([]);
  });

  test("in a plan of nothing", () => {
    expect(literalsOutside(undefined, allowed)).toEqual([]);
  });
});
