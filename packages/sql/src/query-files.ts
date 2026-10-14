/**
 * Query files: a directory of SQL files, one query each, read into the text
 * Postgres is given and what the generated function needs of it — its name,
 * its parameters, the columns its markers make NULL or not, and where each
 * part of the text comes from in the file, for an error to point at.
 *
 * A file is named in lowercase words joined by hyphens, and its function
 * is that name in camel case: `orders-by-customer.sql` is
 * `ordersByCustomer`. The comment the file opens with is the function's
 * documentation.
 *
 * A parameter is a name after a colon, `:customerId`: the same name, the
 * same parameter. One that may be NULL says so, `:note?`, where it first
 * appears. A colon after a letter, a digit, an underscore, a closing
 * bracket or a quote is not a parameter, so that `total::text` and
 * `tags[1:n]` are left as they are, and so is anything in a string, a
 * quoted name or a comment. A quoted name that ends in `!` or `?` is a
 * column the query returns, whose marker says it is never NULL, or may be,
 * whatever Postgres says: the marker is taken off the name.
 *
 * @module
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { textOf } from "./migration-files.ts";

/** A parameter of a query. */
export interface QueryParameter {
  /** Its name, as the query names it after its colon. */
  readonly name: string;

  /** Whether it may be NULL: marked `?`. */
  readonly nullable: boolean;
}

/** A marker of a column's name: never NULL, or maybe NULL. */
export type Marker = "!" | "?";

/** The query of a file, read. */
export interface QueryFile {
  /** The file's path, as messages name it. */
  readonly path: string;

  /** The name of its function. */
  readonly name: string;

  /** What the comment the file opens with says, or nothing. */
  readonly doc: string | undefined;

  /**
   * The query, its parameters numbered `$1` on, its markers taken off, and
   * the space after it as well.
   */
  readonly text: string;

  /** Its parameters, `$1` first. */
  readonly parameters: readonly QueryParameter[];

  /** The columns markers name, by their names without the marker. */
  readonly markers: ReadonlyMap<string, Marker>;

  /**
   * Where a position of `text` is in the file, as `path:line:column`: the
   * position as Postgres gives it, in characters and from 1.
   */
  at(position: number): string;
}

/**
 * A query file that cannot be read as one, and why. The class keeps its
 * name in a bundle, as `MigrationError` does.
 */
export class QueryFileError extends Error {
  static {
    Object.defineProperty(QueryFileError, "name", { value: "QueryFileError" });
  }

  override readonly name = "QueryFileError";
}

/** What a query file's name, without `.sql`, is made of. */
const FILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The names a function cannot take: JavaScript's reserved words; the
 * names of its globals and of `Object.prototype`'s methods, which Biome
 * refuses to see a function shadow; `then`, which would make the module a
 * promise to `await import()`; and the functions the generated file
 * imports.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "undefined",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "then",
  "queryCount",
  "queryRows",
]);

/**
 * What may part two strings that Postgres reads as one: space with a line
 * break in it, and comments of their own lines after it.
 */
const CONTINUATION =
  /^[ \t\f]*(?:\r\n|\r|\n)(?:[ \t\n\r\f]+|--[^\n\r]*(?:\r\n|\r|\n))*$/;

/** A character a word of SQL is made of: after one, `$` and `:` are its own. */
const WORD = /[\p{L}\p{N}_$]/u;

/** A character after which a colon is not a parameter's. */
const NOT_BEFORE_PARAMETER = /[\p{L}\p{N}_$\])"']/u;

/** A parameter: its colon, its name, and its marker when it may be NULL. */
const PARAMETER = /:([A-Za-z_][A-Za-z0-9_]*)(\?)?/y;

/** The tag that opens a dollar-quoted string, such as `$$` or `$body$`. */
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/**
 * Reads the query files of `dir`: the `.sql` files right in it, by their
 * names. Anything else in it is left alone.
 *
 * @throws {QueryFileError} for each file that cannot be read as a query,
 * all of them at once, as one error with each on a line.
 */
export async function readQueryFiles(dir: string): Promise<QueryFile[]> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".sql"))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: QueryFile[] = [];
  const problems: string[] = [];
  const named = new Map<string, string>();

  for (const entry of entries) {
    const path = join(dir, entry.name);

    try {
      if (!(await stat(path).catch(() => undefined))?.isFile()) {
        throw new QueryFileError(`${path}: is not a file`);
      }

      const name = functionNameOf(path, entry.name.slice(0, -4));
      const other = named.get(name);

      if (other !== undefined) {
        throw new QueryFileError(
          `${path}: names the function ${name}, as ${other} does: rename one of them`,
        );
      }

      named.set(name, path);

      const text = await textOf(path);

      if (text === undefined) {
        throw new QueryFileError(`${path}: is not UTF-8: save it as UTF-8`);
      }

      files.push(parseQuery(path, name, text));
    } catch (error) {
      if (!(error instanceof QueryFileError)) {
        throw error;
      }

      problems.push(error.message);
    }
  }

  if (problems.length > 0) {
    throw new QueryFileError(problems.join("\n"));
  }

  return files;
}

/**
 * The function a query file is, by its name without `.sql`.
 *
 * @throws {QueryFileError} when the name is not lowercase words joined by
 * hyphens, or would name a function a name the generated file cannot give
 * one.
 */
export function functionNameOf(path: string, stem: string): string {
  if (!FILE_NAME.test(stem)) {
    throw new QueryFileError(
      `${path}: a query file is named in lowercase words joined by hyphens, such as orders-by-customer.sql`,
    );
  }

  const name = stem.replace(/-([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );

  if (RESERVED.has(name)) {
    throw new QueryFileError(
      `${path}: would name a function ${name}, a name the generated file cannot give one: rename the file`,
    );
  }

  return name;
}

/**
 * Reads `source`, the text of the file at `path`, as the query of the
 * function `name`.
 *
 * @throws {QueryFileError} when it holds no query, a parameter numbered
 * as `$1` or named `__proto__`, a parameter marked `?` in one place and
 * not where it first appears, a column marked both ways, or a NUL.
 */
export function parseQuery(
  path: string,
  name: string,
  source: string,
): QueryFile {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const scanned = scan(path, text);

  return {
    path,
    name,
    doc: docOf(text),
    text: scanned.text,
    parameters: scanned.parameters,
    markers: scanned.markers,
    at: (position) => placeOf(path, text, scanned, position),
  };
}

/** What scanning a query gives. */
interface Scanned {
  readonly text: string;

  /** Where each character of `text`, and its end, comes from in the file. */
  readonly origins: readonly number[];
  readonly parameters: readonly QueryParameter[];
  readonly markers: ReadonlyMap<string, Marker>;
}

/** Scans a query: its parameters numbered, its markers taken off. */
function scan(path: string, source: string): Scanned {
  const parts: string[] = [];
  const origins: number[] = [];
  const numbers = new Map<string, number>();
  const parameters: QueryParameter[] = [];
  const markers = new Map<string, Marker>();
  let index = 0;
  let empty = true;

  /**
   * Where the last string with escapes ended: a string after it that
   * Postgres reads as its continuation takes its escapes too.
   */
  let escaped: number | undefined;

  /** Keeps the source up to `end` as it is. */
  const keep = (end: number) => {
    parts.push(source.slice(index, end));

    for (let at = index; at < end; at += 1) {
      origins.push(at);
    }

    index = end;
  };

  /** A problem at a place of the file. */
  const problem = (at: number, message: string) =>
    new QueryFileError(`${placeIn(path, source, at)}: ${message}`);

  const nul = source.indexOf("\0");

  if (nul !== -1) {
    throw problem(nul, "holds a NUL character, which Postgres cannot be sent");
  }

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === "-" && next === "-") {
      const end = source.indexOf("\n", index);

      keep(end === -1 ? source.length : end);
      continue;
    }

    if (char === "/" && next === "*") {
      keep(commentEnd(source, index));
      continue;
    }

    if (/\s/.test(char)) {
      keep(index + 1);
      continue;
    }

    if (char !== ";") {
      empty = false;
    }

    if (char === "'") {
      const prefix = source[index - 1];
      const escapes =
        ((prefix === "E" || prefix === "e") &&
          !WORD.test(source[index - 2] ?? " ")) ||
        (escaped !== undefined &&
          CONTINUATION.test(source.slice(escaped, index)));
      const end = stringEnd(source, index, escapes);

      keep(end);
      escaped = escapes ? end : undefined;
      continue;
    }

    if (char === '"') {
      const end = quotedEnd(source, index);
      const last = source[end - 2];

      if (
        end - index > 3 &&
        source[end - 1] === '"' &&
        (last === "!" || last === "?")
      ) {
        const column = source.slice(index + 1, end - 2).replaceAll('""', '"');
        const marked = markers.get(column);

        if (marked !== undefined && marked !== last) {
          throw problem(index, `marks the column "${column}" both ! and ?`);
        }

        markers.set(column, last);
        keep(end - 2);
        index = end - 1;
      }

      keep(end);
      continue;
    }

    if (char === "$" && !WORD.test(source[index - 1] ?? " ")) {
      if (next !== undefined && /[0-9]/.test(next)) {
        throw problem(
          index,
          `takes parameters by name, as :id, not by number, as ${/^\$\d+/.exec(source.slice(index))?.[0]}`,
        );
      }

      DOLLAR_TAG.lastIndex = index;

      const tag = DOLLAR_TAG.exec(source)?.[0];

      if (tag !== undefined) {
        const close = source.indexOf(tag, index + tag.length);

        keep(close === -1 ? source.length : close + tag.length);
        continue;
      }
    }

    if (char === ":") {
      if (next === ":") {
        keep(index + 2);
        continue;
      }

      PARAMETER.lastIndex = index;

      const parameter = PARAMETER.exec(source);

      if (
        parameter !== null &&
        !NOT_BEFORE_PARAMETER.test(source[index - 1] ?? " ")
      ) {
        const [whole, name = "", marker] = parameter;
        const nullable = marker === "?";
        let number = numbers.get(name);

        if (name === "__proto__") {
          throw problem(
            index,
            "names a parameter __proto__, which an object of parameters cannot hold: rename it",
          );
        }

        if (number === undefined) {
          parameters.push({ name, nullable });
          number = parameters.length;
          numbers.set(name, number);
        } else if (nullable && !parameters[number - 1]?.nullable) {
          throw problem(
            index,
            `marks :${name} as maybe NULL here, but not where it first appears: mark it there`,
          );
        }

        const replacement = `$${number}`;

        parts.push(replacement);

        for (let at = 0; at < replacement.length; at += 1) {
          origins.push(index);
        }

        index += whole.length;
        continue;
      }
    }

    keep(index + 1);
  }

  if (empty) {
    throw new QueryFileError(`${path}: holds no query`);
  }

  const text = parts.join("").trimEnd();

  origins.length = text.length;
  origins.push(source.trimEnd().length);

  return { text, origins, parameters, markers };
}

/** Where a block comment that starts at `start` ends: comments nest. */
function commentEnd(source: string, start: number): number {
  let depth = 0;
  let at = start;

  while (at < source.length) {
    if (source.startsWith("/*", at)) {
      depth += 1;
      at += 2;
    } else if (source.startsWith("*/", at)) {
      depth -= 1;
      at += 2;

      if (depth === 0) {
        return at;
      }
    } else {
      at += 1;
    }
  }

  return source.length;
}

/**
 * Where a string that starts at `start` ends: a quote doubled is one, and
 * in a string with escapes a backslash takes the character after it as
 * well.
 */
function stringEnd(source: string, start: number, escapes: boolean): number {
  let at = start + 1;

  while (at < source.length) {
    const char = source[at];

    if (escapes && char === "\\") {
      at += 2;
    } else if (char === "'") {
      if (source[at + 1] !== "'") {
        return at + 1;
      }

      at += 2;
    } else {
      at += 1;
    }
  }

  return source.length;
}

/** Where a quoted name that starts at `start` ends: a quote doubled is one. */
function quotedEnd(source: string, start: number): number {
  let at = start + 1;

  while (at < source.length) {
    if (source[at] === '"') {
      if (source[at + 1] !== '"') {
        return at + 1;
      }

      at += 2;
    } else {
      at += 1;
    }
  }

  return source.length;
}

/**
 * What the comment a file opens with says: its lines of `--`, before
 * anything else but blank lines.
 */
function docOf(source: string): string | undefined {
  const lines: string[] = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("--")) {
      lines.push(trimmed.slice(2).replace(/^ /, "").trimEnd());
    } else if (trimmed !== "" || lines.length > 0) {
      break;
    }
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.length === 0 ? undefined : lines.join("\n");
}

/** Where a position of a scanned text, in characters from 1, is in its file. */
function placeOf(
  path: string,
  source: string,
  scanned: Scanned,
  position: number,
): string {
  let index = 0;

  for (
    let count = 1;
    count < position && index < scanned.text.length;
    count += 1
  ) {
    index += (scanned.text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }

  return placeIn(
    path,
    source,
    scanned.origins[Math.min(index, scanned.origins.length - 1)] ?? 0,
  );
}

/** A place of a file, as `path:line:column`. */
function placeIn(path: string, source: string, index: number): string {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");

  return `${path}:${line}:${column}`;
}
