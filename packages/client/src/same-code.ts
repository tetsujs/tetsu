/**
 * Whether two sources hold the same code, whatever their layout: what
 * `tetsu-client contract --check` compares, so that a file a formatter
 * laid out its own way — tabs, single quotes, no semicolons — is not out
 * of date for that.
 *
 * Each source is read as tokens. Whitespace goes; a string is its value,
 * whatever its quotes; a template is its text as it is, which a formatter
 * leaves alone; a comment is its words. The marks
 * a formatter adds or takes away do not count: a semicolon, a comma
 * before a closing bracket, the `|` a broken union starts with, and the
 * quotes of a key.
 *
 * The same reading as `@tetsujs/sql`'s `--check`, copied: the client
 * depends on no other package.
 *
 * @module
 */

/** What a token starts with, and how far it runs. */
const TOKEN =
  /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|[$_\p{ID_Start}][$\p{ID_Continue}]*|\d[\w.]*|[\s\S]/uy;

/** The characters a one-letter escape stands for. */
const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};

/** An escape by code: `x41`, `u0041` or `u{41}`. */
const CODE = /^(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\})/;

/** Tokens a `|` that opens a union may follow. */
const OPENERS: ReadonlySet<string> = new Set(["=", ":", "<", "(", ",", "|"]);

/** Tokens a trailing comma may precede. */
const CLOSERS: ReadonlySet<string> = new Set(["}", "]", ")", ">"]);

/** Whether `a` and `b` hold the same code, whatever their layout. */
export function isSameCode(a: string, b: string): boolean {
  const left = tokensOf(a);
  const right = tokensOf(b);

  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

/** The tokens of a source that count. */
function tokensOf(source: string): string[] {
  const raw: string[] = [];

  TOKEN.lastIndex = 0;

  for (
    let match = TOKEN.exec(source);
    match !== null;
    match = TOKEN.exec(source)
  ) {
    const text = match[0];

    if (/^\s/.test(text)) {
      continue;
    }

    raw.push(
      text.startsWith("//") || text.startsWith("/*")
        ? `comment ${wordsOf(text)}`
        : text.startsWith('"') || text.startsWith("'")
          ? `string ${stringValue(text)}`
          : text,
    );
  }

  const tokens: string[] = [];

  for (const [index, token] of raw.entries()) {
    const next = raw[index + 1] ?? "";
    const previous = tokens.at(-1) ?? "";

    if (
      token === ";" ||
      (token === "," && CLOSERS.has(next)) ||
      (token === "|" && OPENERS.has(previous))
    ) {
      continue;
    }

    tokens.push(
      next === ":" && token.startsWith("string ") ? token.slice(7) : token,
    );
  }

  return tokens;
}

/** A comment's words, without its marks. */
function wordsOf(comment: string): string {
  return comment
    .replace(/^\/\/|^\/\*\*?|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*(?!\/)/, ""))
    .join(" ")
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ");
}

/**
 * The value of a string literal, whatever its quotes: its escapes decoded,
 * so that `"\\n"` and `"\\\\n"` differ and `'\\x41'` is `"A"`.
 */
function stringValue(literal: string): string {
  let value = "";

  for (let index = 1; index < literal.length - 1; index += 1) {
    const char = literal[index] ?? "";

    if (char !== "\\") {
      value += char;
      continue;
    }

    const rest = literal.slice(index + 1, -1);
    const code = CODE.exec(rest);

    if (code !== null) {
      value += String.fromCodePoint(
        Number.parseInt(code[1] ?? code[2] ?? code[3] ?? "", 16),
      );
      index += code[0].length;
      continue;
    }

    const next = rest[0] ?? "";

    value += next === "\n" ? "" : (ESCAPES[next] ?? next);
    index += 1;
  }

  return value;
}
