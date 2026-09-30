/**
 * Compiles the `twoslash` examples of the given pages — or of every page
 * under `src/content/docs` — the way the build does, without building.
 *
 * ```sh
 * bun scripts/check-snippets.ts src/content/docs/docs/concepts/validation.mdx
 * ```
 *
 * @module
 */

import { createTwoslasher } from "@ec-ts/twoslash";
import { Glob } from "bun";
import { twoslashOptions } from "../twoslash.config.ts";

const fence =
  /^([ \t]*)(`{3,}|~{3,})(ts|tsx)\b([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm;

const twoslash = createTwoslasher(twoslashOptions);

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : await Array.fromAsync(new Glob("src/content/docs/**/*.{md,mdx}").scan());

let failures = 0;

for (const file of files) {
  const text = await Bun.file(file).text();

  for (const match of text.matchAll(fence)) {
    const [, indent = "", , lang = "ts", meta = "", body = ""] = match;

    if (!/\btwoslash\b/.test(meta)) continue;

    const code = body
      .split("\n")
      .map((line) =>
        line.startsWith(indent) ? line.slice(indent.length) : line,
      )
      .join("\n");
    const line = text.slice(0, match.index).split("\n").length;

    try {
      const result = twoslash(code, lang);
      const queries = result.queries.map(
        (query) => `    ^? ${query.text.replace(/\n\s*/g, " ")}`,
      );

      console.log(
        `ok   ${file}:${line}${queries.length ? `\n${queries.join("\n")}` : ""}`,
      );
    } catch (error) {
      failures += 1;
      console.log(
        `FAIL ${file}:${line}\n${String(error instanceof Error ? error.message : error).trim()}\n`,
      );
    }
  }
}

console.log(
  failures ? `\n${failures} example(s) failed` : "\nall examples compile",
);
process.exit(failures ? 1 : 0);
