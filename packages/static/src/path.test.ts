/**
 * Tests for which file a path names, without a server: every form a path
 * can take after Bun has resolved `..` and `.` in `req.url`.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { filePath } from "./path.ts";

describe("a path on the root whole", () => {
  test("names its segments, decoded", () => {
    expect(filePath("/css/site.css", undefined)).toEqual({
      segments: ["css", "site.css"],
      directory: false,
    });
    expect(filePath("/a%20b/%C3%BC.txt", undefined)).toEqual({
      segments: ["a b", "ü.txt"],
      directory: false,
    });
  });

  test("ending in a slash names a directory", () => {
    expect(filePath("/", undefined)).toEqual({ segments: [], directory: true });
    expect(filePath("/docs/", undefined)).toEqual({
      segments: ["docs"],
      directory: true,
    });
  });

  test("of a route without a wildcard is the route's whole path", () => {
    expect(filePath("/robots.txt", "/robots.txt")).toEqual({
      segments: ["robots.txt"],
      directory: false,
    });
  });
});

describe("a path below a route's wildcard", () => {
  test("loses the route's prefix", () => {
    expect(filePath("/assets/app.css", "/assets/*")).toEqual({
      segments: ["app.css"],
      directory: false,
    });
    expect(filePath("/admin/ui/app.js", "/admin/ui/*")).toEqual({
      segments: ["app.js"],
      directory: false,
    });
    expect(filePath("/page", "/*")).toEqual({
      segments: ["page"],
      directory: false,
    });
  });

  test("is the root itself at the prefix", () => {
    expect(filePath("/assets/", "/assets/*")).toEqual({
      segments: [],
      directory: true,
    });
    expect(filePath("/assets", "/assets/*")).toEqual({
      segments: [],
      directory: false,
    });
  });

  test("takes any segment for a parameter of the prefix", () => {
    expect(filePath("/acme/files/a.txt", "/:tenant/files/*")).toEqual({
      segments: ["a.txt"],
      directory: false,
    });
  });

  test("is refused outside the prefix, where Bun's resolving of .. leaves it", () => {
    expect(filePath("/x", "/assets/*")).toBeUndefined();
    expect(filePath("/assetsx/a.css", "/assets/*")).toBeUndefined();
    expect(filePath("/x", "/:tenant/files/*")).toBeUndefined();
    expect(filePath("//files/a.txt", "/:tenant/files/*")).toBeUndefined();
  });
});

describe("a refused path", () => {
  const refused: readonly [string, string][] = [
    ["an empty segment", "/docs//guide.html"],
    ["two leading slashes", "//evil.example/docs"],
    ["an encoded slash", "/..%2f..%2fetc/passwd"],
    ["an encoded slash, upper case", "/a%2Fb"],
    ["an encoded backslash", "/a%5cb"],
    ["an encoded NUL", "/a%00b"],
    ["an encoded dot segment Bun did not resolve", "/assets/%2e%2e"],
    ["a dot segment", "/assets/."],
    ["a segment that does not decode", "/a%E0%A4%A"],
    ["a dotfile", "/.env"],
    ["a dot-directory", "/.git/HEAD"],
    ["a dotfile below a directory", "/docs/.htpasswd"],
    ["an encoded dotfile", "/%2eenv"],
  ];

  for (const [what, pathname] of refused) {
    test(`with ${what}`, () => {
      expect(filePath(pathname, undefined)).toBeUndefined();
    });
  }

  test("does not include .well-known", () => {
    expect(filePath("/.well-known/security.txt", undefined)).toEqual({
      segments: [".well-known", "security.txt"],
      directory: false,
    });
  });

  test("is not one with a name decoded once into an escape", () => {
    expect(filePath("/%252e%252e", undefined)).toEqual({
      segments: ["%2e%2e"],
      directory: false,
    });
  });
});
