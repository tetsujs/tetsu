/**
 * Tests for conditional requests, without a server.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { entityTag, isFresh, rangeHolds } from "./conditional.ts";

const modified = Date.UTC(2026, 9, 6, 12, 30, 15, 250);
const lastModified = new Date(modified).toUTCString();
const tag = entityTag(1234, modified);

const withHeaders = (headers: Record<string, string>): Request =>
  new Request("http://test/", { headers });

describe("entityTag", () => {
  test("is weak, from the size and the time in milliseconds, in hexadecimal", () => {
    expect(tag).toBe(`W/"4d2-${modified.toString(16)}"`);
  });

  test("changes within a second", () => {
    expect(entityTag(1234, modified + 1)).not.toBe(tag);
  });
});

describe("isFresh", () => {
  test("holds for the tag the client was given, weakly compared", () => {
    expect(isFresh(withHeaders({ "if-none-match": tag }), tag, modified)).toBe(
      true,
    );
    expect(
      isFresh(withHeaders({ "if-none-match": tag.slice(2) }), tag, modified),
    ).toBe(true);
    expect(
      isFresh(
        withHeaders({ "if-none-match": `"other", ${tag}` }),
        tag,
        modified,
      ),
    ).toBe(true);
    expect(isFresh(withHeaders({ "if-none-match": "*" }), tag, modified)).toBe(
      true,
    );
  });

  test("does not hold for another tag", () => {
    expect(
      isFresh(withHeaders({ "if-none-match": 'W/"4d2-0"' }), tag, modified),
    ).toBe(false);
  });

  test("holds for a date no earlier than the last change, to the second", () => {
    expect(
      isFresh(
        withHeaders({ "if-modified-since": lastModified }),
        tag,
        modified,
      ),
    ).toBe(true);
    expect(
      isFresh(
        withHeaders({
          "if-modified-since": new Date(modified + 60_000).toUTCString(),
        }),
        tag,
        modified,
      ),
    ).toBe(true);
  });

  test("does not hold for an earlier date, or one that does not parse", () => {
    expect(
      isFresh(
        withHeaders({
          "if-modified-since": new Date(modified - 1000).toUTCString(),
        }),
        tag,
        modified,
      ),
    ).toBe(false);
    expect(
      isFresh(withHeaders({ "if-modified-since": "yesterday" }), tag, modified),
    ).toBe(false);
    expect(isFresh(withHeaders({}), tag, modified)).toBe(false);
  });

  test("reads If-None-Match alone when both are sent", () => {
    expect(
      isFresh(
        withHeaders({
          "if-none-match": 'W/"4d2-0"',
          "if-modified-since": lastModified,
        }),
        tag,
        modified,
      ),
    ).toBe(false);
  });
});

describe("rangeHolds", () => {
  test("holds without If-Range", () => {
    expect(rangeHolds(withHeaders({ range: "bytes=0-1" }), modified)).toBe(
      true,
    );
  });

  test("holds for the Last-Modified the client was given", () => {
    expect(
      rangeHolds(withHeaders({ "if-range": lastModified }), modified),
    ).toBe(true);
  });

  test("does not hold for another date", () => {
    expect(
      rangeHolds(
        withHeaders({ "if-range": new Date(modified + 60_000).toUTCString() }),
        modified,
      ),
    ).toBe(false);
  });

  test("does not hold for an entity tag that reads as the date", () => {
    expect(
      rangeHolds(withHeaders({ "if-range": `"${lastModified}"` }), modified),
    ).toBe(false);
  });

  test("does not hold for an entity tag, which must match strongly", () => {
    expect(rangeHolds(withHeaders({ "if-range": tag }), modified)).toBe(false);
    expect(
      rangeHolds(withHeaders({ "if-range": tag.slice(2) }), modified),
    ).toBe(false);
  });
});
