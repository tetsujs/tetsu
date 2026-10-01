/**
 * Compiles the `twoslash` examples of the given pages — or of every page
 * under `src/content/docs` and the home page's samples — the way the build
 * does, without building.
 *
 * ```sh
 * bun scripts/check-snippets.ts src/content/docs/docs/concepts/validation.mdx
 * ```
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import { createTwoslasher } from "@ec-ts/twoslash";
import { Glob } from "bun";
import { heroCode } from "../src/components/home/hero-code.ts";
import { caught, tabs } from "../src/components/home/samples.ts";
import { twoslashOptions } from "../twoslash.config.ts";

const site = fileURLToPath(new URL("../", import.meta.url));

const fence =
  /^([ \t]*)(`{3,}|~{3,})(ts|tsx)\b([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm;

const twoslash = createTwoslasher(twoslashOptions);

interface Example {
  where: string;
  code: string;
  lang: string;
}

const examples: Example[] = [];

const pages =
  process.argv.length > 2
    ? process.argv.slice(2)
    : await Array.fromAsync(
        new Glob("src/content/docs/**/*.{md,mdx}").scan(site),
        (file) => site + file,
      );

for (const file of pages) {
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

    examples.push({ where: `${file.replace(site, "")}:${line}`, code, lang });
  }
}

if (process.argv.length <= 2) {
  examples.push({ where: "home: hero", code: heroCode, lang: "ts" });

  for (const { label, code } of [...caught, ...tabs]) {
    examples.push({ where: `home: ${label}`, code, lang: "ts" });
  }
}

let failures = 0;

for (const { where, code, lang } of examples) {
  try {
    const result = twoslash(code, lang);
    const queries = result.queries.map(
      (query) => `    ^? ${query.text.replace(/\n\s*/g, " ")}`,
    );

    console.log(
      `ok   ${where}${queries.length ? `\n${queries.join("\n")}` : ""}`,
    );
  } catch (error) {
    failures += 1;
    console.log(
      `FAIL ${where}\n${String(error instanceof Error ? error.message : error).trim()}\n`,
    );
  }
}

// Every page scanned and nothing found means the pages are not where this
// looks for them, not that there is nothing to check.
if (!examples.length) {
  console.log("no twoslash examples in these pages");
  process.exit(process.argv.length > 2 ? 0 : 1);
}

console.log(
  failures
    ? `\n${failures} of ${examples.length} example(s) failed`
    : `\nall ${examples.length} examples compile`,
);
process.exit(failures ? 1 : 0);
