/**
 * Reading the lists and the non-null arrays checks promise, from the text
 * Postgres 14 and 18 print a check as. A shape read wrong would type a
 * column with values it does not allow, so every shape not read in full
 * must promise nothing.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { forbidsNullElements, valuesOf } from "./checks.ts";

const column = (name: string) => ({ column: name });
const domain = { domain: true } as const;

describe("a list a check allows", () => {
  test.each([
    [
      "CHECK ((a = ANY (ARRAY['retail'::text, 'bulk'::text, 'it''s'::text])))",
      "a",
      ["retail", "bulk", "it's"],
    ],
    [
      "CHECK (((b)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))",
      "b",
      ["x", "y"],
    ],
    ["CHECK ((c = 'only'::text))", "c", ["only"]],
    ["CHECK (((d)::text = 'v'::text))", "d", ["v"]],
    ["CHECK ((e = ANY (ARRAY[1, 2, '-3'::integer])))", "e", ["1", "2", "-3"]],
    ["CHECK ((f = '-1'::integer))", "f", ["-1"]],
    ["CHECK ((g = 7))", "g", ["7"]],
    [
      "CHECK ((h = ANY (ARRAY['new'::order_status, 'paid'::order_status])))",
      "h",
      ["new", "paid"],
    ],
    [
      "CHECK ((h = ANY (ARRAY['new'::billing.state, 'paid'::\"My State\"])))",
      "h",
      ["new", "paid"],
    ],
    ["CHECK ((\"Mixed Case\" = 'm'::text))", "Mixed Case", ["m"]],
    ['CHECK (("say ""hi""" = \'s\'::text))', 'say "hi"', ["s"]],
    [
      "CHECK ((o = ANY (ARRAY['é'::text, 'ü\"q'::text, 'a, b'::text])))",
      "o",
      ["é", 'ü"q', "a, b"],
    ],
  ])("%s allows its values for %s", (definition, name, values) => {
    expect(valuesOf(definition, column(name))).toEqual(values);
  });

  test.each([
    ["CHECK ((VALUE = ANY (ARRAY['a'::text, 'b'::text])))", ["a", "b"]],
    ["CHECK (((VALUE)::text = 'x'::text))", ["x"]],
  ])("%s allows its values for a domain", (definition, values) => {
    expect(valuesOf(definition, domain)).toEqual(values);
  });

  test.each([
    ["CHECK ((a = 'x'::text))", "b", "another column"],
    [
      "CHECK ((\"VALUE\" = 'x'::text))",
      undefined,
      "a column named VALUE, for a domain",
    ],
    [
      "CHECK ((VALUE = 'x'::text))",
      "VALUE",
      "a domain's VALUE, for a column named so",
    ],
    [
      "CHECK (((k = ANY (ARRAY['a'::text, 'b'::text])) OR (k IS NULL)))",
      "k",
      "a list with more to it",
    ],
    ["CHECK ((VALUE >= 0))", "VALUE", "a comparison"],
    ["CHECK ((a <> 'x'::text))", "a", "an inequality"],
    ["CHECK ((lower(a) = 'x'::text))", "a", "a function of the column"],
    [
      "CHECK ((a = ANY (ARRAY['1.5'::numeric(10,2), '2'::numeric(10,2)])))",
      "a",
      "a cast with a comma in it",
    ],
    ["CHECK ((a = ANY (ARRAY[])))", "a", "an empty list"],
    ["CHECK ((a = ANY (ARRAY['x'::text, b])))", "a", "a column in the list"],
    [
      "CHECK (((s)::integer = ANY (ARRAY[1, 2])))",
      "s",
      "the column cast to a number, which lets '01' in",
    ],
    [
      "CHECK (((c)::citext = ANY (ARRAY['a'::citext, 'b'::citext])))",
      "c",
      "the column cast to citext, which lets 'A' in",
    ],
    [
      "CHECK (((b)::bpchar = ANY (ARRAY['ab'::bpchar])))",
      "b",
      "the column cast to char, which lets 'ab ' in",
    ],
    [
      "CHECK (((s)::text = ANY ((ARRAY['abc'::character varying(1), 'b'::character varying(1)])::text[])))",
      "s",
      "values cast with a modifier, which turns 'abc' into 'a'",
    ],
    [
      "CHECK ((s = 'abc'::character varying(1)))",
      "s",
      "a value cast with a modifier",
    ],
    ["CHECK ((a = 1.5))", "a", "a decimal"],
    ["CHECK ((a = ANY ('{x,y}'::text[])))", "a", "an array literal"],
  ])("%s promises nothing for %s: %s", (definition, name) => {
    expect(
      valuesOf(definition, name === undefined ? domain : column(name)),
    ).toBeUndefined();
  });

  test("a value that reads as SQL is still a value of the list it is in", () => {
    expect(
      valuesOf(
        "CHECK ((a = ANY (ARRAY['b = ANY (c'::text, 'd'::text])))",
        column("a"),
      ),
    ).toEqual(["b = ANY (c", "d"]);
  });
});

describe("an array a check keeps free of NULL", () => {
  test.each([
    ["CHECK ((array_position(i, NULL::text) IS NULL))", column("i")],
    ["CHECK ((array_position(j, NULL::integer) IS NULL))", column("j")],
    [
      'CHECK ((array_position("My Tags", NULL::character varying) IS NULL))',
      column("My Tags"),
    ],
    ["CHECK ((array_position(VALUE, NULL::text) IS NULL))", domain],
  ])("%s keeps it so", (definition, target) => {
    expect(forbidsNullElements(definition, target)).toBe(true);
  });

  test.each([
    ["CHECK ((array_position(i, NULL::text) IS NULL))", column("j")],
    ["CHECK ((array_position(i, 'x'::text) IS NULL))", column("i")],
    ["CHECK ((array_position(i, NULL::text) IS NOT NULL))", column("i")],
    [
      "CHECK (((array_position(i, NULL::text) IS NULL) OR (i IS NULL)))",
      column("i"),
    ],
    ["CHECK ((cardinality(i) > 0))", column("i")],
    ["CHECK ((array_position(VALUE, NULL::text) IS NULL))", column("VALUE")],
  ])("%s does not, for %j", (definition, target) => {
    expect(forbidsNullElements(definition, target)).toBe(false);
  });
});
