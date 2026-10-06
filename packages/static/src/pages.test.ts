/**
 * Tests for what a browser gets for a path with no file, through a live
 * server: the site's not-found page, or the shell of a single-page app.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { staticFiles } from "./index.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A directory of files in the system's temporary directory, removed after the tests. */
function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tetsu-static-"));

  roots.push(root);

  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  return root;
}

/** What a browser sends when it navigates. */
const navigation = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const root = site({
  "index.html": "<h1>App</h1>",
  "errors/404.html": "<h1>Not here</h1>",
  "app.js": "console.log('app');",
  ".env": "SECRET=1",
});

describe("notFound", () => {
  const request = serve(
    createApp({
      routes: [],
      fallback: staticFiles({ root, notFound: "errors/404.html" }),
    }),
  );

  test("is sent with 404 to a browser", async () => {
    const res = await request("/orders/42", { headers: navigation });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not here</h1>");
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  test("is not sent to a client that does not ask for HTML", async () => {
    const res = await request("/api/ordrs");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(res.headers.get("vary")).toBe("Accept");

    const json = await request("/api/ordrs", {
      headers: { accept: "application/json" },
    });

    expect(json.headers.get("content-type")).toStartWith("application/json");
    expect(
      (
        await request("/x", { headers: { accept: "text/html;q=0, */*" } })
      ).headers.get("content-type"),
    ).toStartWith("application/json");
  });

  test("is sent for a refused path, which has no file", async () => {
    const res = await request("/.env", { headers: navigation });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not here</h1>");
  });

  test("is sent on HEAD without its body", async () => {
    const res = await request("/missing", {
      method: "HEAD",
      headers: navigation,
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
  });

  test("is not sent to another method", async () => {
    const res = await request("/missing", {
      method: "POST",
      headers: navigation,
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("application/json");
  });

  test("is not a 304, whatever the client holds", async () => {
    const first = await request("/missing", { headers: navigation });
    const again = await request("/missing", {
      headers: {
        ...navigation,
        "if-none-match": first.headers.get("etag") ?? "",
      },
    });

    expect(again.status).toBe(404);
    expect(await again.text()).toBe("<h1>Not here</h1>");
  });

  test("leaves a file that exists alone", async () => {
    const res = await request("/app.js", { headers: navigation });

    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toBeNull();
  });

  test("gone after startup leaves the application's 404", async () => {
    const root = site({ "404.html": "<h1>Not here</h1>" });
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({ root, notFound: "404.html" }),
      }),
    );

    rmSync(join(root, "404.html"));

    const res = await request("/missing", { headers: navigation });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
  });
});

describe("spa", () => {
  const paths: string[] = [];

  const request = serve(
    createApp({
      routes: [],
      fallback: staticFiles({
        root,
        spa: true,
        cacheControl: (path) => {
          paths.push(path);

          return path.endsWith(".html")
            ? "no-cache"
            : "public, max-age=31536000";
        },
      }),
    }),
  );

  test("sends the shell with 200 to a browser at an address with no file", async () => {
    const res = await request("/orders/42", { headers: navigation });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>App</h1>");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  test("gives cacheControl the shell's path, not the address", async () => {
    paths.length = 0;

    const res = await request("/orders/42", { headers: navigation });

    expect(paths).toEqual(["index.html"]);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("answers a missing script or an API address with the application's 404", async () => {
    const script = await request("/assets/app.123.js");

    expect(script.status).toBe(404);
    expect(await script.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(script.headers.get("vary")).toBe("Accept");

    const post = await request("/api/ordrs", {
      method: "POST",
      headers: navigation,
    });

    expect(post.status).toBe(404);
  });

  test("lets the shell be revalidated", async () => {
    const first = await request("/orders/42", { headers: navigation });
    const again = await request("/settings", {
      headers: {
        ...navigation,
        "if-none-match": first.headers.get("etag") ?? "",
      },
    });

    expect(again.status).toBe(304);
  });

  test("leaves a file that exists alone", async () => {
    const res = await request("/app.js", { headers: navigation });

    expect(await res.text()).toBe("console.log('app');");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000");
  });
});
