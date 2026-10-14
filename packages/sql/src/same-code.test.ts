/**
 * Comparing two sources as code, whatever their layout: a file a formatter
 * laid out its own way is the same file, and a file that says anything
 * else — a type, a member, a name, a comment — is not.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { holdsCode, isSameCode } from "./same-code.ts";

const root = join(import.meta.dir, "../../..");
const biome = join(root, "node_modules/.bin/biome");
const golden = await Bun.file(
  join(import.meta.dir, "../test-utils/fixtures/schema/db.generated.ts"),
).text();

/** A source laid out by Biome with these flags. */
function formatted(source: string, flags: readonly string[]): string {
  const result = Bun.spawnSync(
    [biome, "format", ...flags, "--stdin-file-path=packages/sql/same.ts"],
    { cwd: root, stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return result.stdout.toString();
}

const source = `/**
 * The database.
 *
 * @module
 */

import type { Schema } from "@tetsujs/sql";

export type Kind = "retail" | "bulk";

export interface DB {
  orders: {
    /** Where it is. */
    status: Kind;
    "Mixed Case": string | null;
  };
}

export type Constraint =
  | "orders_pkey"
  | "orders_status_check";

export const schema: Schema<DB, Constraint> = {
  journal: "migrations",
  migration: null,
};
`;

describe("the same code", () => {
  test("is the same, as it is", () => {
    expect(isSameCode(golden, golden)).toBe(true);
  });

  test.each([
    [
      "tabs, single quotes, no semicolons and no trailing commas",
      [
        "--indent-style=tab",
        "--javascript-formatter-quote-style=single",
        "--semicolons=as-needed",
        "--trailing-commas=none",
      ],
    ],
    ["a line of 120", ["--line-width=120"]],
    ["a line of 40", ["--line-width=40"]],
  ])("is the same, laid out with %s", (_, flags) => {
    const other = formatted(golden, flags);

    expect(other).not.toBe(golden);
    expect(isSameCode(golden, other)).toBe(true);
  });

  test.each([
    ["CRLF line ends", source.replaceAll("\n", "\r\n")],
    ["a byte order mark", `${String.fromCharCode(0xfeff)}${source}`],
    [
      "a union on one line",
      source.replace('=\n  | "orders_pkey"\n  |', '= "orders_pkey" |'),
    ],
    ["quoted keys", source.replace("    status:", '    "status":')],
    [
      "a comment laid out over lines",
      source.replace(
        "/** Where it is. */",
        "/**\n     * Where it is.\n     */",
      ),
    ],
  ])("is the same with %s", (_, other) => {
    expect(isSameCode(source, other)).toBe(true);
  });
});

describe("other code", () => {
  test.each([
    ["a type changed", source.replace("status: Kind;", "status: string;")],
    [
      "a member added",
      source.replace('"retail" | "bulk"', '"retail" | "bulk" | "online"'),
    ],
    ["a member gone", source.replace('  | "orders_status_check"', "")],
    ["a column renamed", source.replace("status: Kind;", "state: Kind;")],
    ["a quoted key renamed", source.replace('"Mixed Case"', '"Mixed case"')],
    ["nullable", source.replace("status: Kind;", "status: Kind | null;")],
    ["a comment changed", source.replace("Where it is.", "Where it was.")],
    ["a comment gone", source.replace("    /** Where it is. */\n", "")],
    [
      "a string changed",
      source.replace('journal: "migrations"', 'journal: "journal"'),
    ],
    ["a string's quote inside it", source.replace('"retail"', "'retail\"'")],
    [
      "a value for null",
      source.replace("migration: null", "migration: undefined"),
    ],
  ])("is not the same: %s", (_, other) => {
    expect(other).not.toBe(source);
    expect(isSameCode(source, other)).toBe(false);
  });

  test.each([
    ['"line\\nbreak"', '"line\\\\nbreak"'],
    ['"\\u001b"', '"\\\\u001b"'],
    ['"tab\\there"', '"tab\\\\there"'],
  ])(
    "is not the same: the escape %s and the characters %s",
    (escaped, characters) => {
      expect(
        isSameCode(
          `export type Tone = ${escaped};`,
          `export type Tone = ${characters};`,
        ),
      ).toBe(false);
    },
  );

  test.each([
    ["'\\x41'", '"A"'],
    ['"\\u0041"', '"A"'],
    ['"\\u{41}"', "'A'"],
    ["'it\\'s'", '"it\'s"'],
    ['"say \\"hi\\""', "'say \"hi\"'"],
    ['"tab\\there"', `"tab${"\t"}here"`],
  ])("is the same: %s and %s", (a, b) => {
    expect(
      isSameCode(`export type Tone = ${a};`, `export type Tone = ${b};`),
    ).toBe(true);
  });

  test.each([
    ["the quotes of SQL", "where note = 'label'", 'where note = "label"'],
    ["a cast of a string", "'label'::text", "label::text"],
    ["the space in a string of SQL", "$$a  b$$", "$$a b$$"],
    ["the lines of SQL", "select 1\nfrom t", "select 1 from t"],
    ["a semicolon in SQL", "select 1;", "select 1"],
  ])("is not the same: a template whose text differs in %s", (_, a, b) => {
    expect(
      isSameCode(
        `const Q = { text: \`${a}\` };`,
        `const Q = { text: \`${b}\` };`,
      ),
    ).toBe(false);
  });

  test("is the same: a template laid out as before around it", () => {
    expect(
      isSameCode(
        "const Q = { text: `select 1\nfrom t`, names: [] };",
        "const Q = {\n\ttext: `select 1\nfrom t`,\n\tnames: [],\n}",
      ),
    ).toBe(true);
  });

  test("is not the same when one source ends early", () => {
    expect(
      isSameCode(
        source,
        source.slice(0, source.indexOf("export type Constraint")),
      ),
    ).toBe(false);
  });
});

describe("code a source holds", () => {
  test.each([
    ["as written", 'export const schema = {\n  int8: "string",\n};'],
    [
      "in tabs and single quotes",
      "export const schema = {\n\tint8: 'string'\n}",
    ],
    ["under a quoted key", 'export const schema = { "int8": "string" };'],
  ])("is found %s", (_, source) => {
    expect(holdsCode(source, 'int8: "string"')).toBe(true);
  });

  test.each([
    ["in a comment", '/** int8: "string" */\nexport const schema = {};'],
    ["as a type", "interface Row {\n  int8: string;\n}"],
    ["with another value", 'export const schema = { int8: "bigint" };'],
  ])("is not found %s", (_, source) => {
    expect(holdsCode(source, 'int8: "string"')).toBe(false);
  });
});
