/**
 * Reading query files: the names of their functions, their parameters,
 * what is left alone — casts, slices, strings, quoted names, comments —
 * the markers of columns, the comment that documents a query, and where a
 * position Postgres gives is in the file.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  functionNameOf,
  parseQuery,
  QueryFileError,
  readQueryFiles,
} from "./query-files.ts";

const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-queries-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** The query of `source`, read as `q.sql`. */
function parse(source: string) {
  return parseQuery("q.sql", "q", source);
}

/** What reading `source` throws. */
function failure(source: string): unknown {
  try {
    parse(source);
  } catch (error) {
    return error;
  }

  throw new Error("the query was read");
}

/** A directory of query files of its own. */
async function directory(files: Readonly<Record<string, string>>) {
  const dir = await mkdtemp(join(scratch, "dir-"));

  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
  }

  return dir;
}

describe("the name of a query's function", () => {
  test("is its file's in camel case", () => {
    expect(functionNameOf("x", "orders-by-customer")).toBe("ordersByCustomer");
    expect(functionNameOf("x", "orders")).toBe("orders");
    expect(functionNameOf("x", "top-10")).toBe("top10");
    expect(functionNameOf("x", "v2-orders")).toBe("v2Orders");
  });

  test("is refused for a file not named in lowercase words joined by hyphens", () => {
    for (const stem of [
      "Orders",
      "orders_by_customer",
      "orders--by",
      "-orders",
      "orders-",
      "1-orders",
      "заказы",
      "",
    ]) {
      expect(() => functionNameOf(`queries/${stem}.sql`, stem)).toThrow(
        `queries/${stem}.sql: a query file is named in lowercase words joined by hyphens, such as orders-by-customer.sql`,
      );
    }
  });

  test("is refused when JavaScript keeps it for itself, Biome would see it shadow a global, a module would be a promise of it, or the generated file imports it", () => {
    for (const [stem, name] of [
      ["delete", "delete"],
      ["undefined", "undefined"],
      ["to-string", "toString"],
      ["constructor", "constructor"],
      ["parse-int", "parseInt"],
      ["then", "then"],
      ["query-rows", "queryRows"],
      ["query-count", "queryCount"],
    ] as const) {
      expect(() => functionNameOf(`queries/${stem}.sql`, stem)).toThrow(
        new QueryFileError(
          `queries/${stem}.sql: would name a function ${name}, a name the generated file cannot give one: rename the file`,
        ),
      );
    }
  });
});

describe("a parameter", () => {
  test("is numbered where it first appears, and the same name is the same parameter", () => {
    const query = parse("select * from t where a = :x and b = :y or c = :x");

    expect(query.text).toBe(
      "select * from t where a = $1 and b = $2 or c = $1",
    );
    expect(query.parameters).toEqual([
      { name: "x", nullable: false },
      { name: "y", nullable: false },
    ]);
  });

  test("may be NULL when marked so where it first appears", () => {
    const query = parse("select :note? as a, :note as b, :id as c");

    expect(query.text).toBe("select $1 as a, $1 as b, $2 as c");
    expect(query.parameters).toEqual([
      { name: "note", nullable: true },
      { name: "id", nullable: false },
    ]);
  });

  test("marked so only where it appears later is refused, at that place", () => {
    expect(failure("select :note as a,\n  :note? as b")).toEqual(
      new QueryFileError(
        "q.sql:2:3: marks :note as maybe NULL here, but not where it first appears: mark it there",
      ),
    );
  });

  test("goes after an operator, a bracket, a comma or a space, and takes a cast", () => {
    expect(
      parse("select f(:a,:b), array[:c], x=:d, (:e)::int8, :f::text").text,
    ).toBe("select f($1,$2), array[$3], x=$4, ($5)::int8, $6::text");
  });

  test("is not a cast, a slice, nor a colon after a name, a bracket or a quote", () => {
    const source =
      'select total::text, tags[1:n], tags[lo:hi], f(x):y, (a)[1:2], "q":z';

    expect(parse(source)).toMatchObject({ text: source, parameters: [] });
  });

  test("is nothing in a string, a quoted name, a dollar-quoted string or a comment", () => {
    const source = [
      "select ':a', 'it''s :b', E'\\':c', e'\\\\', \":d\", $$ :e $$, $tag$ :f $x$ $tag$",
      "-- :g",
      "/* :h /* :i */ :j */ :k",
    ].join("\n");

    expect(parse(source)).toMatchObject({
      text: source.replace(":k", "$1"),
      parameters: [{ name: "k", nullable: false }],
    });
  });

  test("named __proto__ is refused, as an object of parameters cannot hold it", () => {
    expect(failure("select :__proto__")).toEqual(
      new QueryFileError(
        "q.sql:1:8: names a parameter __proto__, which an object of parameters cannot hold: rename it",
      ),
    );
  });

  test("is nothing in a string with escapes that goes on, past a line break, in another", () => {
    const source = "select E'a'\n'\\' :x ', E'b'\n-- note\n'\\' :y ', :z";

    expect(parse(source)).toMatchObject({
      text: source.replace(":z", "$1"),
      parameters: [{ name: "z", nullable: false }],
    });
  });

  test("by number is refused, where it is, but not in a name", () => {
    expect(failure("select 1\nwhere id = $1")).toEqual(
      new QueryFileError(
        "q.sql:2:12: takes parameters by name, as :id, not by number, as $1",
      ),
    );
    expect(parse("select a$1, $$x$$").parameters).toEqual([]);
  });
});

describe("a marker", () => {
  test("is taken off a quoted name, and says the column is never NULL, or may be", () => {
    const query = parse(
      'select count(*) as "total!", max(x) "top?", "plain", "!", "a""b!" from t',
    );

    expect(query.text).toBe(
      'select count(*) as "total", max(x) "top", "plain", "!", "a""b" from t',
    );
    expect(query.markers).toEqual(
      new Map([
        ["total", "!"],
        ["top", "?"],
        ['a"b', "!"],
      ]),
    );
  });

  test("is refused when it marks a column both ways", () => {
    expect(failure('select 1 as "x!", 2 as "x?"')).toEqual(
      new QueryFileError('q.sql:1:24: marks the column "x" both ! and ?'),
    );
  });
});

describe("a query file", () => {
  test("is documented by the comment it opens with", () => {
    expect(
      parse(
        "\n-- The orders.\n--\n--   Newest first.\n\n-- Not this.\nselect 1",
      ).doc,
    ).toBe("The orders.\n\n  Newest first.");
    expect(parse("select 1 -- not this").doc).toBe(undefined);
    expect(parse("-- The one.\n--\nselect 1").doc).toBe("The one.");
  });

  test("keeps its comments, and loses its byte order mark and its trailing space", () => {
    expect(parse("\uFEFF-- Doc.\nselect 1;  \n\n").text).toBe(
      "-- Doc.\nselect 1;",
    );
  });

  test("that holds no query is refused", () => {
    for (const source of [
      "",
      "  \n",
      "-- only a comment\n",
      "/* x */",
      ";",
      " ;; -- x",
    ]) {
      expect(failure(source)).toEqual(
        new QueryFileError("q.sql: holds no query"),
      );
    }
  });

  test("that holds a NUL is refused, where it is", () => {
    expect(failure("select 'a\0'")).toEqual(
      new QueryFileError(
        "q.sql:1:10: holds a NUL character, which Postgres cannot be sent",
      ),
    );
  });
});

describe("a position Postgres gives", () => {
  test("is the line and the column of the file", () => {
    const query = parse("select\n  nope\nfrom t");

    expect(query.at(10)).toBe("q.sql:2:3");
    expect(query.at(1)).toBe("q.sql:1:1");
  });

  test("is where it was before parameters were numbered and markers taken off", () => {
    const query = parse('select :customerId, "a!", bad');

    expect(query.text).toBe('select $1, "a", bad');
    expect(query.at(query.text.indexOf("bad") + 1)).toBe("q.sql:1:27");
    expect(query.at(8)).toBe("q.sql:1:8");
    expect(query.at(9)).toBe("q.sql:1:8");
  });

  test("counts characters, as Postgres does, not UTF-16 units", () => {
    const query = parse("select '😀', nope");

    expect(query.at(13)).toBe("q.sql:1:14");
  });

  test("past the end is the end of the query", () => {
    const query = parse("select 1 from\n\n");

    expect(query.at(14)).toBe("q.sql:1:14");
  });
});

describe("a directory of query files", () => {
  test("is read file by file, by name, past anything but .sql files", async () => {
    const dir = await directory({
      "b-orders.sql": "select 2",
      "a-orders.sql": "select 1",
      "README.md": "# Queries",
    });

    await mkdir(join(dir, "nested"));

    const files = await readQueryFiles(dir);

    expect(files.map((file) => [file.path, file.name, file.text])).toEqual([
      [join(dir, "a-orders.sql"), "aOrders", "select 1"],
      [join(dir, "b-orders.sql"), "bOrders", "select 2"],
    ]);
  });

  test("tells every file it cannot read, at once", async () => {
    const dir = await directory({
      "Bad.sql": "select 1",
      "orders-2.sql": "select 1",
      "orders2.sql": "select 2",
      "numbered.sql": "select $1",
      "empty.sql": "",
    });

    await mkdir(join(dir, "folder.sql"));

    const error = await readQueryFiles(dir).catch((failure) => failure);

    expect(error).toBeInstanceOf(QueryFileError);
    expect((error as Error).message.split("\n")).toEqual([
      `${join(dir, "Bad.sql")}: a query file is named in lowercase words joined by hyphens, such as orders-by-customer.sql`,
      `${join(dir, "empty.sql")}: holds no query`,
      `${join(dir, "folder.sql")}: is not a file`,
      `${join(dir, "numbered.sql")}:1:8: takes parameters by name, as :id, not by number, as $1`,
      `${join(dir, "orders2.sql")}: names the function orders2, as ${join(dir, "orders-2.sql")} does: rename one of them`,
    ]);
  });

  test("reads a file a link leads to, and refuses a link that leads nowhere", async () => {
    const dir = await directory({ "target.txt": "select 1" });

    await symlink(join(dir, "target.txt"), join(dir, "linked.sql"));
    await symlink(join(dir, "missing.txt"), join(dir, "broken.sql"));

    const error = await readQueryFiles(dir).catch((failure) => failure);

    expect((error as Error).message).toBe(
      `${join(dir, "broken.sql")}: is not a file`,
    );

    await rm(join(dir, "broken.sql"));

    expect(
      (await readQueryFiles(dir)).map((file) => [file.name, file.text]),
    ).toEqual([["linked", "select 1"]]);
  });

  test("that is not there fails", async () => {
    await expect(
      readQueryFiles(join(scratch, "nowhere")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
