/**
 * Tests for serving files, through a live server: what a path finds, the
 * methods, the routes it is mounted on, and the hooks around it.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, group, HttpError, hook, route } from "@tetsujs/core";
import { captureErrors, serve, testCtx } from "@tetsujs/core/testing";
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

/**
 * The head of the response to a request sent as written: `fetch` would
 * resolve the path, and collapse the leading `//`, before sending it.
 */
function rawHead(url: URL, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";

    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`,
      );
    });

    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("end", () => resolve(received.split("\r\n\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

const elsewhere = site({ "shared.txt": "linked into the site" });

const root = site({
  "index.html": "<h1>Home</h1>",
  "app.js": "console.log('app');",
  "robots.txt": "User-agent: *",
  "docs/index.html": "<h1>Docs</h1>",
  "docs/guide.html": "<h1>Guide</h1>",
  "a b.txt": "spaced",
  "ü.txt": "unicode",
  ".env": "SECRET=1",
  ".git/HEAD": "ref: refs/heads/main",
  "docs/.htpasswd": "admin:secret",
  ".well-known/security.txt": "Contact: mailto:security@example.com",
});

mkdirSync(join(root, "empty"));
symlinkSync(elsewhere, join(root, "linked"));
symlinkSync(join(root, "app.js"), join(root, "alias.js"));
symlinkSync("loop-b", join(root, "loop-a"));
symlinkSync("loop-a", join(root, "loop-b"));

const request = serve(
  createApp({ routes: [], fallback: staticFiles({ root }) }),
);

describe("a file", () => {
  test("is sent with its type, its length and its validators", async () => {
    const res = await request("/app.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app');");
    expect(res.headers.get("content-type")).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(res.headers.get("content-length")).toBe("19");
    expect(res.headers.get("etag")).toStartWith('W/"13-');
    expect(res.headers.get("last-modified")).toEndWith(" GMT");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("keeps its type and length on HEAD, without a body", async () => {
    const res = await request("/app.js", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(res.headers.get("content-length")).toBe("19");
  });

  test("is found by its encoded name", async () => {
    expect(await (await request("/a%20b.txt")).text()).toBe("spaced");
    expect(await (await request("/%C3%BC.txt")).text()).toBe("unicode");
  });

  test("is not found with a slash after it", async () => {
    expect((await request("/app.js/")).status).toBe(404);
  });

  test("is not a directory a path goes through", async () => {
    expect((await request("/app.js/inside.js")).status).toBe(404);
  });

  test("with a name too long to exist is not found", async () => {
    expect((await request(`/${"x".repeat(300)}.js`)).status).toBe(404);
  });

  test("that is missing is the application's 404", async () => {
    const res = await request("/missing.js");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      status: 404,
      message: "Not Found",
      error: "NOT_FOUND",
    });
  });

  test("behind a symbolic link is sent, inside the root or out of it", async () => {
    expect(await (await request("/alias.js")).text()).toBe(
      "console.log('app');",
    );
    expect(await (await request("/linked/shared.txt")).text()).toBe(
      "linked into the site",
    );
  });
});

describe("a directory", () => {
  test("is its index file", async () => {
    expect(await (await request("/")).text()).toBe("<h1>Home</h1>");
    expect(await (await request("/docs/")).text()).toBe("<h1>Docs</h1>");
  });

  test("without its slash is redirected to it, the query kept", async () => {
    const res = await request("/docs?lang=en", { redirect: "manual" });

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs/?lang=en");
  });

  test("without an index file is not found, and not redirected", async () => {
    expect((await request("/empty/")).status).toBe(404);
    expect((await request("/empty", { redirect: "manual" })).status).toBe(404);
  });

  test("is not found with index: false", async () => {
    const request = serve(
      createApp({ routes: [], fallback: staticFiles({ root, index: false }) }),
    );

    expect((await request("/")).status).toBe(404);
    expect((await request("/docs/")).status).toBe(404);
    expect((await request("/docs", { redirect: "manual" })).status).toBe(404);
  });

  test("is the index file the options name", async () => {
    const request = serve(
      createApp({
        routes: [],
        fallback: staticFiles({ root, index: "guide.html" }),
      }),
    );

    expect(await (await request("/docs/")).text()).toBe("<h1>Guide</h1>");
    expect((await request("/")).status).toBe(404);
  });
});

describe("a refused path", () => {
  test("is a dotfile or a dot-directory", async () => {
    expect((await request("/.env")).status).toBe(404);
    expect((await request("/.git/HEAD")).status).toBe(404);
    expect((await request("/docs/.htpasswd")).status).toBe(404);
  });

  test("is not .well-known", async () => {
    expect(await (await request("/.well-known/security.txt")).text()).toBe(
      "Contact: mailto:security@example.com",
    );
  });

  test("has an encoded separator, a NUL or an encoding that does not decode", async () => {
    expect((await request("/..%2f..%2fetc%2fpasswd")).status).toBe(404);
    expect((await request("/docs%2fguide.html")).status).toBe(404);
    expect((await request("/docs%5cguide.html")).status).toBe(404);
    expect((await request("/app.js%00.txt")).status).toBe(404);
    expect((await request("/%E0%A4%A")).status).toBe(404);
  });

  test("has an empty segment, sent as written", async () => {
    expect(await rawHead(request.url, "/docs//guide.html")).toStartWith(
      "HTTP/1.1 404",
    );
  });

  test("of a directory is not redirected off the site, sent as written", async () => {
    const head = await rawHead(request.url, "//evil.example/docs");

    expect(head).toStartWith("HTTP/1.1 404");
    expect(head.toLowerCase()).not.toContain("location");
  });

  test("of a directory is not redirected off the site, the handler called directly", async () => {
    const files = staticFiles({ root });

    for (const url of [
      "http://test//evil.example/..%2fdocs",
      "http://test//evil.example/docs",
      "http://test///docs",
    ]) {
      const refusal = await files(
        testCtx({ req: new Request(url), route: undefined }),
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(HttpError);
      expect((refusal as HttpError).status).toBe(404);
    }

    const answer = await files(
      testCtx({ req: new Request("http://test/docs?x=1"), route: undefined }),
    );

    expect(answer.headers.get("location")).toBe("/docs/?x=1");
  });
});

describe("a method other than GET and HEAD", () => {
  test("is a 405 with Allow where a file is", async () => {
    const res = await request("/app.js", { method: "POST" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.json()).toMatchObject({ error: "METHOD_NOT_ALLOWED" });
    expect((await request("/docs", { method: "DELETE" })).status).toBe(405);
    expect((await request("/app.js", { method: "OPTIONS" })).status).toBe(405);
  });

  test("is a 404 where no file is, as without files", async () => {
    const res = await request("/api/ordrs", { method: "POST" });

    expect(res.status).toBe(404);
    expect(res.headers.get("allow")).toBeNull();
    expect((await request("/.env", { method: "PUT" })).status).toBe(404);
  });
});

describe("a failure of the disk", () => {
  const errors = captureErrors();

  test("other than a missing file is a 500", async () => {
    const res = await request("/loop-a");

    expect(res.status).toBe(500);
    expect(errors.lines.join("\n")).toContain("ELOOP");
  });
});

describe("on a route", () => {
  const assets = site({
    "app.css": "body {}",
    "index.html": "<h1>Assets</h1>",
    "fonts/index.html": "<h1>Fonts</h1>",
    "robots.txt": "User-agent: assets",
  });

  const files = staticFiles({ root: assets });

  const request = serve(
    createApp({
      routes: [
        route({ method: "GET", path: "/assets/*", handler: files }),
        route({ method: "GET", path: "/:tenant/files/*", handler: files }),
        route({ method: "GET", path: "/robots.txt", handler: files }),
        group("/admin", {
          children: [route({ method: "GET", path: "/ui/*", handler: files })],
        }),
      ],
    }),
  );

  test("serves what follows its wildcard", async () => {
    expect(await (await request("/assets/app.css")).text()).toBe("body {}");
    expect(await (await request("/assets/")).text()).toBe("<h1>Assets</h1>");
    expect(await (await request("/acme/files/app.css")).text()).toBe("body {}");
    expect(await (await request("/admin/ui/app.css")).text()).toBe("body {}");
  });

  test("without a wildcard serves its own path", async () => {
    expect(await (await request("/robots.txt")).text()).toBe(
      "User-agent: assets",
    );
  });

  test("redirects a directory within its prefix", async () => {
    const res = await request("/assets/fonts", { redirect: "manual" });

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/assets/fonts/");
  });

  test("does not serve a path that leaves its prefix", async () => {
    const head = await rawHead(request.url, "/assets/../robots.txt");

    expect(head).toStartWith("HTTP/1.1 404");
  });

  test("leaves HEAD and other methods to the core", async () => {
    const head = await request("/assets/app.css", { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/css;charset=utf-8");

    const post = await request("/assets/app.css", { method: "POST" });

    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("the application's hooks", () => {
  const marked = hook.beforeParse((ctx) => {
    ctx.out.headers.set("x-frame-options", "DENY");
  });

  const files = staticFiles({ root });

  const request = serve(
    createApp({
      hooks: { beforeParse: [marked] },
      routes: [
        route({
          method: "GET",
          path: "/downloads/*",
          handler: (ctx) => {
            ctx.out.headers.set("content-disposition", "attachment");

            return files(ctx);
          },
        }),
      ],
      fallback: files,
    }),
  );

  test("apply to a file in the fallback", async () => {
    const res = await request("/app.js");

    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("apply to a file on a route, and to its 404", async () => {
    const res = await request("/downloads/app.js");

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-disposition")).toBe("attachment");

    const missing = await request("/downloads/missing.js");

    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-frame-options")).toBe("DENY");
  });
});
