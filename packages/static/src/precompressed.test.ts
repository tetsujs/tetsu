/**
 * Tests for sending the compressed copy beside a file, through a live
 * server. Bun's `fetch` decompresses a response unless told not to, and
 * every request here tells it not to, so the bytes compared are the bytes
 * sent.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { staticFiles } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "tetsu-static-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const script = "console.log('a bundle, the largest response a site sends');";
const brotli = brotliCompressSync(script);
const gzip = Bun.gzipSync(script);

const built = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
const compressed = new Date(Date.UTC(2026, 9, 6, 12, 0, 1));
const rebuilt = new Date(Date.UTC(2026, 9, 6, 13, 0, 0));

/** Writes a file with the time it was changed. */
function write(name: string, content: string | Uint8Array, at: Date): void {
  writeFileSync(join(root, name), content);
  utimesSync(join(root, name), at, at);
}

write("app.js", script, built);
write("app.js.br", brotli, compressed);
write("app.js.gz", gzip, compressed);
write("only-gzip.js", script, built);
write("only-gzip.js.gz", gzip, compressed);
write("stale.js", script, rebuilt);
write("stale.js.br", brotli, compressed);
write("plain.txt", "no copies", built);
write("index.html", "<h1>App</h1>", built);
write("index.html.br", brotliCompressSync("<h1>App</h1>"), compressed);
write("404.html", "<h1>Not here</h1>", built);
write("404.html.gz", Bun.gzipSync("<h1>Not here</h1>"), compressed);

const request = serve(
  createApp({
    routes: [],
    fallback: staticFiles({ root, precompressed: true }),
  }),
);

/** A request whose response arrives as it was sent, compressed or not. */
const raw = (path: string, headers: Record<string, string>, method = "GET") =>
  request(path, { method, headers, decompress: false } as RequestInit);

const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("a compressed copy", () => {
  test("in Brotli is sent to a client that takes it, with the original's type", async () => {
    const res = await raw("/app.js", {
      "accept-encoding": "gzip, deflate, br, zstd",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-length")).toBe(String(brotli.length));
    expect(await bytes(res)).toEqual(new Uint8Array(brotli));
  });

  test("in gzip is sent to a client that takes only gzip", async () => {
    const res = await raw("/app.js", { "accept-encoding": "gzip" });

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await bytes(res)).toEqual(gzip);
  });

  test("follows the client's weights", async () => {
    const weighted = await raw("/app.js", {
      "accept-encoding": "br;q=0.5, gzip",
    });

    expect(weighted.headers.get("content-encoding")).toBe("gzip");

    const refused = await raw("/app.js", { "accept-encoding": "gzip, br;q=0" });

    expect(refused.headers.get("content-encoding")).toBe("gzip");
  });

  test("in gzip is sent when it is the only one", async () => {
    const res = await raw("/only-gzip.js", { "accept-encoding": "br, gzip" });

    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("older than its original is left over from a build, and not sent", async () => {
    const res = await raw("/stale.js", { "accept-encoding": "br" });

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(script);
  });

  test("has validators of its own", async () => {
    const original = await raw("/app.js", {});
    const copy = await raw("/app.js", { "accept-encoding": "br" });

    expect(copy.headers.get("etag")).not.toBe(original.headers.get("etag"));
    expect(copy.headers.get("last-modified")).toBe(compressed.toUTCString());

    const revalidated = await raw("/app.js", {
      "accept-encoding": "br",
      "if-none-match": copy.headers.get("etag") ?? "",
    });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("vary")).toBe("Accept-Encoding");
  });

  test("has its own length on HEAD and its own bytes in a range", async () => {
    const head = await raw("/app.js", { "accept-encoding": "br" }, "HEAD");

    expect(head.headers.get("content-length")).toBe(String(brotli.length));

    const part = await raw("/app.js", {
      "accept-encoding": "br",
      range: "bytes=0-3",
    });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-encoding")).toBe("br");
    expect(await bytes(part)).toEqual(new Uint8Array(brotli.subarray(0, 4)));
  });

  test("is not sent without Accept-Encoding, which still varies the answer", async () => {
    const res = await raw("/app.js", {});

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe(script);
  });

  test("missing leaves the file as it is", async () => {
    const res = await raw("/plain.txt", { "accept-encoding": "br, gzip" });

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("no copies");
  });
});

describe("a page", () => {
  const navigation = {
    accept: "text/html,*/*;q=0.8",
    "accept-encoding": "gzip, br",
  };

  test("not found is sent compressed", async () => {
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({
          root,
          notFound: "404.html",
          precompressed: true,
        }),
      }),
    );

    const res = await request("/missing", {
      headers: navigation,
      decompress: false,
    } as RequestInit);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Accept");
  });

  test("of a single-page app is sent compressed", async () => {
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({ root, spa: true, precompressed: true }),
      }),
    );

    const res = await request("/orders/42", {
      headers: navigation,
      decompress: false,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
  });
});

describe("without precompressed", () => {
  test("no copy is sent, and nothing varies", async () => {
    const request = serve(
      createApp({ routes: [], fallback: staticFiles({ root }) }),
    );
    const res = await request("/app.js", {
      headers: { "accept-encoding": "br, gzip" },
      decompress: false,
    } as RequestInit);

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(await res.text()).toBe(script);
  });
});
