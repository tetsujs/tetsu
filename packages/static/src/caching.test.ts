/**
 * Tests for what lets a client keep a file and fetch part of it, through a
 * live server: validators, `304`, `Cache-Control`, `Range` and `If-Range`.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { staticFiles } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "tetsu-static-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const changed = new Date(Date.UTC(2026, 9, 6, 12, 30, 15, 250));

writeFileSync(join(root, "data.txt"), "0123456789abcdefghij");
utimesSync(join(root, "data.txt"), changed, changed);

const { mtimeMs } = statSync(join(root, "data.txt"));
const tag = `W/"14-${Math.floor(mtimeMs).toString(16)}"`;
const lastModified = changed.toUTCString();

const request = serve(
  createApp({ routes: [], fallback: staticFiles({ root }) }),
);

describe("validators", () => {
  test("are a weak ETag of size and time, and Last-Modified", async () => {
    const res = await request("/data.txt");

    expect(res.headers.get("etag")).toBe(tag);
    expect(res.headers.get("last-modified")).toBe(lastModified);
  });

  test("answer If-None-Match with 304, carrying what a cache updates", async () => {
    const res = await request("/data.txt", {
      headers: { "if-none-match": tag },
    });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(tag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("answer If-Modified-Since with 304", async () => {
    const res = await request("/data.txt", {
      headers: { "if-modified-since": lastModified },
    });

    expect(res.status).toBe(304);
  });

  test("send the file for a copy that is not current", async () => {
    const stale = await request("/data.txt", {
      headers: { "if-none-match": 'W/"14-0"' },
    });

    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789abcdefghij");

    const older = await request("/data.txt", {
      headers: {
        "if-modified-since": new Date(changed.getTime() - 60_000).toUTCString(),
      },
    });

    expect(older.status).toBe(200);
  });

  test("follow If-None-Match over If-Modified-Since", async () => {
    const res = await request("/data.txt", {
      headers: {
        "if-none-match": 'W/"14-0"',
        "if-modified-since": lastModified,
      },
    });

    expect(res.status).toBe(200);
  });
});

describe("cacheControl", () => {
  const nested = mkdtempSync(join(tmpdir(), "tetsu-static-"));

  afterAll(() => {
    rmSync(nested, { recursive: true, force: true });
  });

  writeFileSync(join(nested, "index.html"), "<h1>Home</h1>");
  writeFileSync(join(nested, "app.3f2a.js"), "console.log('app');");

  test("is the string given", async () => {
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({
          root: nested,
          cacheControl: "public, max-age=60",
        }),
      }),
    );

    expect((await request("/app.3f2a.js")).headers.get("cache-control")).toBe(
      "public, max-age=60",
    );
  });

  test("is what the function says for the file's path below the root", async () => {
    const paths: string[] = [];
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({
          root: nested,
          cacheControl: (path) => {
            paths.push(path);

            return path.endsWith(".js")
              ? "public, max-age=31536000, immutable"
              : "no-cache";
          },
        }),
      }),
    );

    expect((await request("/app.3f2a.js")).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await request("/")).headers.get("cache-control")).toBe("no-cache");
    expect(paths).toEqual(["app.3f2a.js", "index.html"]);
  });
});

describe("Range", () => {
  test("is cut from the file by Bun, with 206", async () => {
    const res = await request("/data.txt", { headers: { range: "bytes=0-4" } });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("01234");
    expect(res.headers.get("content-range")).toBe("bytes 0-4/20");
    expect(res.headers.get("etag")).toBe(tag);
  });

  test("outside the file is a 416", async () => {
    const res = await request("/data.txt", {
      headers: { range: "bytes=100-200" },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */20");
  });

  test("holds with If-Range naming the file's Last-Modified", async () => {
    const res = await request("/data.txt", {
      headers: { range: "bytes=0-4", "if-range": lastModified },
    });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("01234");
  });

  test("gives way to the whole file when If-Range names another", async () => {
    const date = await request("/data.txt", {
      headers: {
        range: "bytes=0-4",
        "if-range": new Date(changed.getTime() + 60_000).toUTCString(),
      },
    });

    expect(date.status).toBe(200);
    expect(await date.text()).toBe("0123456789abcdefghij");

    const entity = await request("/data.txt", {
      headers: { range: "bytes=0-4", "if-range": tag },
    });

    expect(entity.status).toBe(200);
    expect(await entity.text()).toBe("0123456789abcdefghij");
  });
});
