/**
 * Tests for reading `Accept` and `Accept-Encoding`, without a server.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { acceptedEncodings, acceptsHtml } from "./negotiation.ts";

const withHeader = (name: string, value: string): Request =>
  new Request("http://test/", { headers: { [name]: value } });

describe("acceptsHtml", () => {
  test("is true for a browser's navigation", () => {
    expect(
      acceptsHtml(
        withHeader(
          "accept",
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
      ),
    ).toBe(true);
    expect(acceptsHtml(withHeader("accept", "TEXT/HTML; charset=utf-8"))).toBe(
      true,
    );
  });

  test("is false for what fetch, curl and API clients send", () => {
    expect(acceptsHtml(new Request("http://test/"))).toBe(false);
    expect(acceptsHtml(withHeader("accept", "*/*"))).toBe(false);
    expect(acceptsHtml(withHeader("accept", "text/*"))).toBe(false);
    expect(acceptsHtml(withHeader("accept", "application/json"))).toBe(false);
  });

  test("is false for HTML refused with a weight of 0", () => {
    expect(acceptsHtml(withHeader("accept", "text/html;q=0, */*"))).toBe(false);
    expect(acceptsHtml(withHeader("accept", "text/html;q=x"))).toBe(false);
  });
});

describe("acceptedEncodings", () => {
  test("puts Brotli before gzip when both are taken alike", () => {
    expect(
      acceptedEncodings(
        withHeader("accept-encoding", "gzip, deflate, br, zstd"),
      ),
    ).toEqual(["br", "gzip"]);
  });

  test("orders by weight", () => {
    expect(
      acceptedEncodings(withHeader("accept-encoding", "br;q=0.5, gzip;q=1")),
    ).toEqual(["gzip", "br"]);
  });

  test("leaves out what is refused or not named", () => {
    expect(
      acceptedEncodings(withHeader("accept-encoding", "gzip, br;q=0")),
    ).toEqual(["gzip"]);
    expect(acceptedEncodings(withHeader("accept-encoding", "deflate"))).toEqual(
      [],
    );
    expect(
      acceptedEncodings(withHeader("accept-encoding", "identity")),
    ).toEqual([]);
    expect(acceptedEncodings(new Request("http://test/"))).toEqual([]);
  });

  test("takes * for what it does not name", () => {
    expect(acceptedEncodings(withHeader("accept-encoding", "*"))).toEqual([
      "br",
      "gzip",
    ]);
    expect(
      acceptedEncodings(withHeader("accept-encoding", "br;q=0, *;q=0.5")),
    ).toEqual(["gzip"]);
  });

  test("reads names in any case", () => {
    expect(
      acceptedEncodings(withHeader("accept-encoding", "GZIP, Br")),
    ).toEqual(["br", "gzip"]);
  });
});
