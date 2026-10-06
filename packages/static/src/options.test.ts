/**
 * Tests for the options refused when the handler is made, so that a
 * mistake stops the application at startup rather than on a request.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StaticOptions } from "./index.ts";
import { staticFiles } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "tetsu-static-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

writeFileSync(join(root, "index.html"), "<h1>Home</h1>");
writeFileSync(join(root, "404.html"), "<h1>Not here</h1>");
mkdirSync(join(root, "errors"));

/** Options as plain JavaScript may pass them, past the types. */
const loosely = (options: Record<string, unknown>) =>
  staticFiles(options as unknown as StaticOptions);

describe("root", () => {
  test("that does not exist is refused, naming where it was looked for", () => {
    expect(() => staticFiles({ root: "./no-such-dist" })).toThrow(
      `staticFiles: root "./no-such-dist" is ${join(process.cwd(), "no-such-dist")}, which does not exist — a relative root is resolved against the working directory, ${process.cwd()}`,
    );
  });

  test("that is a file is refused", () => {
    expect(() => staticFiles({ root: join(root, "index.html") })).toThrow(
      "which is not a directory",
    );
  });

  test("that is not a path is refused", () => {
    expect(() => loosely({ root: "" })).toThrow(
      'staticFiles: root must be the path of a directory, got ""',
    );
    expect(() => loosely({})).toThrow(
      "staticFiles: root must be the path of a directory, got undefined",
    );
    expect(() => loosely({ root: new URL("file:///srv") })).toThrow(
      "got an object",
    );
    expect(() => loosely({ root, cacheControl: Symbol("x") })).toThrow(
      "got a symbol",
    );
  });
});

describe("index", () => {
  test("that is not the name of a file is refused", () => {
    for (const index of ["", ".", "..", "docs/index.html", "..\\index.html"]) {
      expect(() => staticFiles({ root, index })).toThrow(
        `staticFiles: index must be the name of a file, such as "index.html", or false, got ${JSON.stringify(index)}`,
      );
    }

    expect(() => loosely({ root, index: true })).toThrow("got true");
  });
});

describe("notFound", () => {
  test("outside the root is refused", () => {
    expect(() => staticFiles({ root, notFound: "../404.html" })).toThrow(
      `staticFiles: notFound "../404.html" is outside the root, ${root}`,
    );
    expect(() => staticFiles({ root, notFound: "/etc/hosts" })).toThrow(
      "is outside the root",
    );
  });

  test("that is not a file is refused", () => {
    expect(() => staticFiles({ root, notFound: "missing.html" })).toThrow(
      `staticFiles: notFound "missing.html" is ${join(root, "missing.html")}, which does not exist`,
    );
    expect(() => staticFiles({ root, notFound: "errors" })).toThrow(
      "which is not a file",
    );
    expect(() => loosely({ root, notFound: 404 })).toThrow(
      "staticFiles: notFound must be the path of a file below the root, got 404",
    );
  });
});

describe("spa", () => {
  test("with notFound is refused", () => {
    expect(() => loosely({ root, spa: true, notFound: "404.html" })).toThrow(
      "staticFiles: spa and notFound both answer a browser's request for a path with no file",
    );
  });

  test("with index: false is refused", () => {
    expect(() => loosely({ root, spa: true, index: false })).toThrow(
      "staticFiles: spa answers with the root's index file, and index is false",
    );
  });

  test("without the index file is refused", () => {
    expect(() => staticFiles({ root, spa: true, index: "app.html" })).toThrow(
      `staticFiles: the index file "app.html" that spa answers with is ${join(root, "app.html")}, which does not exist`,
    );
  });

  test("that is not a boolean is refused", () => {
    expect(() => loosely({ root, spa: "yes" })).toThrow(
      'staticFiles: spa must be true or false, got "yes"',
    );
  });
});

describe("cacheControl", () => {
  test("that cannot be a header is refused", () => {
    expect(() => staticFiles({ root, cacheControl: "" })).toThrow(
      'staticFiles: cacheControl must be a Cache-Control value or a function of the file\'s path, got ""',
    );
    expect(() =>
      staticFiles({ root, cacheControl: "no-cache\nx-injected: 1" }),
    ).toThrow("cannot be the value of a header");
    expect(() => loosely({ root, cacheControl: 60 })).toThrow("got 60");
  });
});

describe("precompressed", () => {
  test("that is not a boolean is refused", () => {
    expect(() => loosely({ root, precompressed: "br" })).toThrow(
      'staticFiles: precompressed must be true or false, got "br"',
    );
  });
});
