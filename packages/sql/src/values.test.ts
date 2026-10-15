/**
 * Writing values as Postgres text: the ISO text of a `Date`, and the
 * literal of an array, quoted so that no element's text is read as part of
 * the literal. That Postgres reads each literal back as the array it was
 * is held by `database.test.ts`, for every type of element.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { arrayLiteral, isoOf } from "./values.ts";

describe("a Date", () => {
  test("is written as its ISO text, in UTC", () => {
    expect(isoOf(new Date("2026-10-12T21:30:00.123+03:00"))).toBe(
      "2026-10-12T18:30:00.123Z",
    );
  });

  test.each([
    [Date.UTC(10_000, 0, 2, 3, 4, 5), "10000-01-02T03:04:05.000Z"],
    [Date.UTC(275_760, 0, 1), "275760-01-01T00:00:00.000Z"],
  ])("past 9999 is written with its year's digits: %p", (time, iso) => {
    expect(isoOf(new Date(time))).toBe(iso);
  });

  test("before the year 1 is written as the year Before Christ it is", () => {
    const zero = new Date("0000-03-15T12:00:00.000Z");
    const caesar = new Date("-000043-03-15T12:00:00.000Z");

    expect(isoOf(zero)).toBe("0001-03-15T12:00:00.000Z BC");
    expect(isoOf(caesar)).toBe("0044-03-15T12:00:00.000Z BC");
  });

  test("that is invalid is refused, as Bun would store the epoch", () => {
    expect(() => isoOf(new Date(Number.NaN))).toThrow(
      new RangeError(
        "an invalid Date cannot be written: it holds no time, and Bun would store the epoch",
      ),
    );
  });
});

describe("an array literal", () => {
  test.each([
    [[], "{}"],
    [["a", "b"], '{"a","b"}'],
    [[""], '{""}'],
    [["NULL", "null"], '{"NULL","null"}'],
    [[null, undefined], "{NULL,NULL}"],
    [['say "hi"'], '{"say \\"hi\\""}'],
    [["back\\slash"], '{"back\\\\slash"}'],
    [["a,b", "{c}", " d ", "e;f"], '{"a,b","{c}"," d ","e;f"}'],
    [["tab\there", "line\nbreak"], '{"tab\there","line\nbreak"}'],
    [["注文", "ünï"], '{"注文","ünï"}'],
  ])("of strings %j is %s", (values, literal) => {
    expect(arrayLiteral(values, ",")).toBe(literal);
  });

  test.each([
    ["numbers", [1, -2.5, 0, -0], '{"1","-2.5","0","-0"}'],
    [
      "numbers that are no number",
      [Number.NaN, Number.POSITIVE_INFINITY],
      '{"NaN","Infinity"}',
    ],
    ["bigints", [9007199254740993n, -1n], '{"9007199254740993","-1"}'],
    ["booleans", [true, false], '{"true","false"}'],
  ])("of %s is %s", (_, values, literal) => {
    expect(arrayLiteral(values, ",")).toBe(literal);
  });

  test("of Dates holds their ISO text", () => {
    expect(
      arrayLiteral([new Date("2026-10-12T00:00:00Z"), "2026-10-13"], ","),
    ).toBe('{"2026-10-12T00:00:00.000Z","2026-10-13"}');
  });

  test("with an invalid Date is refused", () => {
    expect(() => arrayLiteral([new Date(Number.NaN)], ",")).toThrow(RangeError);
  });

  test("of bytes holds the hex a bytea reads, of a view's own bytes only", () => {
    const whole = new Uint8Array([9, 0, 1, 255, 9]);

    expect(
      arrayLiteral(
        [Buffer.from("hi"), new Uint8Array([0, 1, 255]), whole.subarray(1, 4)],
        ",",
      ),
    ).toBe('{"\\\\x6869","\\\\x0001ff","\\\\x0001ff"}');
  });

  test("of objects holds their JSON", () => {
    expect(arrayLiteral([{ a: 1, 'q"': "v\\" }], ",")).toBe(
      '{"{\\"a\\":1,\\"q\\\\\\"\\":\\"v\\\\\\\\\\"}"}',
    );
  });

  test("with holes has NULL in them", () => {
    const sparse: unknown[] = ["a"];

    sparse[2] = "c";

    expect(arrayLiteral(sparse, ",")).toBe('{"a",NULL,"c"}');
  });

  test("of arrays has an array of the literal's own for each, so that one of more dimensions is written as it was", () => {
    expect(
      arrayLiteral(
        [
          ["a", "b,c"],
          ["d", null],
        ],
        ",",
      ),
    ).toBe('{{"a","b,c"},{"d",NULL}}');
    expect(
      arrayLiteral(
        [
          ["(1,1),(0,0)", "(2,2),(1,1)"],
          ["(3,3),(2,2)", "(4,4),(3,3)"],
        ],
        ";",
      ),
    ).toBe('{{"(1,1),(0,0)";"(2,2),(1,1)"};{"(3,3),(2,2)";"(4,4),(3,3)"}}');
  });

  test("of json holds the JSON of each element, an array among them, and NULL for null", () => {
    expect(
      arrayLiteral(
        [{ a: 1, 'q"': "v\\" }, [1, "two"], "text", 3, true, null, undefined],
        "json",
      ),
    ).toBe(
      '{"{\\"a\\":1,\\"q\\\\\\"\\":\\"v\\\\\\\\\\"}","[1,\\"two\\"]","\\"text\\"","3","true",NULL,NULL}',
    );
  });

  test("is separated by its delimiter", () => {
    expect(arrayLiteral(["(1,1),(0,0)", "(2,2),(1,1)", null], ";")).toBe(
      '{"(1,1),(0,0)";"(2,2),(1,1)";NULL}',
    );
  });
});
