---
title: "@tetsujs/static"
description: Files from a directory — a built site, a single-page app or assets — with caching headers, precompressed copies and the application's hooks.
sidebar:
  order: 10
  label: "@tetsujs/static"
---

`@tetsujs/static` serves the files of a directory: a built site next to the
API, a single-page app, or a directory of assets. It is a handler, so it
runs inside the pipeline, and the application's hooks apply to files as to
everything else: security headers, CORS, a request log.

```bash
bun add @tetsujs/static
```

## Usage

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
import { staticFiles } from "@tetsujs/static";

const app = createApp({
  routes,
  fallback: staticFiles({ root: "./dist", notFound: "404.html" }),
});
```

In `fallback`, it answers every path no route matched: `/css/site.css` is
`dist/css/site.css`, and `/` is `dist/index.html`. A path with no file gets
the application's `404`, the same JSON as any other missing path, and a
browser gets `404.html` ([below](#a-page-for-a-missing-path)).

On a route, it answers what follows the route's `*`:

```ts twoslash
import { route } from "@tetsujs/core";
import { staticFiles } from "@tetsujs/static";
// ---cut---
const assets = route({
  method: "GET",
  path: "/assets/*",
  handler: staticFiles({ root: "./public" }),
});
```

`/assets/app.css` is `public/app.css`. A route without `*`, such as
`/robots.txt`, serves its own path from the root. The route's group, hooks
and `docs` apply as to any other route, so files behind a sign-in are a
group with the sign-in hook and a route `/*`.

`root` is resolved against the working directory, as `Bun.file` resolves a
path, not against the module that calls `staticFiles()`. For the module's
own directory, use `join(import.meta.dir, "public")`. `staticFiles()`
checks the root when it is called, so a wrong one stops the application at
startup.

Every file goes out with:

- its `content-type`, on `HEAD` too;
- `ETag` and `Last-Modified`, and a `304` when the client's copy is still
  the file;
- `Cache-Control`, `no-cache` unless [`cacheControl`](#caching) says
  otherwise;
- `Accept-Ranges: bytes`: Bun answers a `Range` with `206`, or `416` for
  one outside the file.

## Paths

A path is checked before the disk is touched, and refused rather than
repaired. These get a `404`:

- `..`, `.` and an empty segment, as in `//`;
- an encoded `/` or `\`, and a NUL;
- a dotfile or a dot-directory, so `.env` and `.git` are never served.
  `.well-known` is the one exception.

A directory's address without its trailing slash is redirected to it with
`301`, the query kept, so the relative links in its `index.html` work:
`/docs` to `/docs/`. The `Location` always starts with exactly one `/`, so
a path such as `//evil.example/docs` cannot send a browser to another site.
`index: false` turns directories off.

Symbolic links are followed, as nginx, Caddy and Express follow them: what
the root links to is served as part of it. What the root holds is yours to
decide. Serve a build's output, not a project's directory.

A route serves everything below its root, including files that a narrower
route guards. Bun's router matches a path as it arrives and resolves `..`
only afterwards. So `/assets/x/../private/report.pdf` is answered by
`/assets/*`, not by a `/assets/private/*` route with a sign-in hook, and
the file goes out. Keep files that need a guard out of the root of a
broader route, in a directory of their own.

## Methods

In `fallback`, `GET` and `HEAD` get the file. Another method gets `405`
with `Allow: GET, HEAD` where a file exists, and `404` where none does, so
a `POST` to a mistyped API address is the usual `404`. On a route, the
core answers the other methods, as for any route.

## Caching

`cacheControl` sets `Cache-Control`. The default, `no-cache`, lets a
browser keep a file but makes it ask whether the file changed before using
it, and the answer is a small `304` when it has not. Without the header, a
browser guesses how long to keep a file from its age, and can go on running
an old script after a deploy.

A file whose name changes with its content, as a bundler names what it puts
in `assets/`, can be kept for good:

```ts twoslash
import { staticFiles } from "@tetsujs/static";
// ---cut---
staticFiles({
  root: "./dist",
  cacheControl: (path) =>
    path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
});
```

The function gets the file's path below the root, not the address. The
shell of a single-page app is `index.html` at every address it answers, so
a rule for `.html` covers it.

## A page for a missing path

`notFound` names a file below the root, sent with `404` to a browser that
asked for a path with no file. Only a request whose `Accept` names
`text/html`, as a browser's navigation does, gets the page. `fetch`, curl
and every API client get the application's `404`, so a mistyped API
address is not answered with a page. Both carry `Vary: Accept`, so a cache
keeps them apart.

## Single-page apps

An app with a router of its own, such as React Router or Vue Router, reads
the address in the browser. A reload on `/orders/42` must load the app,
though no file has that path. `spa: true` answers a browser's request for a
path with no file with the root's `index.html` and `200`:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { staticFiles } from "@tetsujs/static";
declare const routes: object[];
// ---cut---
const app = createApp({ routes, fallback: staticFiles({ root: "./dist", spa: true }) });
```

A request that does not ask for HTML still gets the application's `404`:
a script missing after a deploy, a mistyped API address. The app's router
shows its own page for an address it does not know. `spa` and `notFound`
exclude each other.

The app must load its assets from absolute paths, `/assets/app.js`, which
is what bundlers such as Vite produce by default. A relative
`assets/app.js` on the page `/orders/42` is fetched from
`/orders/assets/app.js`.

## Compressed copies

Bun compresses nothing on its own, and a bundle is the largest response a
site sends. With `precompressed: true`, a client whose `Accept-Encoding`
takes it gets the copy beside a file, `app.js.br`, then `app.js.gz`, with
`Content-Encoding` and the original's type. The build makes the copies
once, with a plugin of the bundler or a few lines of Bun after it:

```ts twoslash
import { brotliCompressSync } from "node:zlib";

for await (const path of new Bun.Glob("dist/**/*.{html,js,css,svg,json}").scan()) {
  const bytes = await Bun.file(path).bytes();

  await Bun.write(`${path}.br`, brotliCompressSync(bytes));
  await Bun.write(`${path}.gz`, Bun.gzipSync(bytes));
}
```

A copy has its own `ETag`, `Last-Modified` and length, and a `Range` is
cut from its bytes. A copy older than its original is left over from an
earlier build and is not sent, so a build that forgot to compress again
does not serve the old bundle. Every file then carries
`Vary: Accept-Encoding`, so a cache keeps the copies apart. The page of
`notFound` and the shell of `spa` have copies too.

## Wrapping the handler

The handler returns a `Response`, so headers of one route go on
`ctx.out.headers` before it runs:

```ts twoslash
import { route } from "@tetsujs/core";
import { staticFiles } from "@tetsujs/static";
// ---cut---
const files = staticFiles({ root: "./uploads" });

const downloads = route({
  method: "GET",
  path: "/downloads/*",
  docs: { hidden: true },
  handler: (ctx) => {
    ctx.out.headers.set("content-disposition", "attachment");

    return files(ctx);
  },
});
```

The route mounts the arrow, not the handler, and the arrow tells the
OpenAPI document nothing: without `docs: { hidden: true }`, the route would
be in it, answering a `200`.

Files your users uploaded are not the site's own. An HTML page or an SVG
served from the site's domain runs its scripts as the site. Serve uploads
from a domain of their own, or as attachments, as above.

## In the OpenAPI document

A route of files is left out of the
[generated document](/docs/packages/openapi/). Nearly every one serves a
site's assets, and a generated client would get a method that cannot fetch
a nested file: OpenAPI cannot say that the parameter of a `*` holds
slashes, so a client encodes them. `docs: { hidden: false }` on the route
shows it, and the handler describes what it answers: a file of any type
with its headers, `206`, `301`, `304`, `404` and `416`. Show a flat
directory, such as `/downloads/*`. `fallback` is not in the document at
all, since it has no path.

## Next to Bun's own static routes

Bun's own `{ dir }` routes serve a directory a few microseconds faster per
request, as they skip the pipeline, but they skip what it does too. No hook
runs for them, so security headers, CORS and logs do not apply, and they
serve `.env` and `.git` like any other file, answer `POST` with the file,
and send no `Cache-Control`. They suit a directory with nothing secret in
it that needs none of that.

## Options

| Option | Default | |
| --- | --- | --- |
| `root` | required | the directory served, from the working directory |
| `index` | `"index.html"` | the file a directory is answered with; `false` for none |
| `notFound` | none | a file below the root, sent with `404` to a browser |
| `spa` | `false` | `true` sends the root's index file with `200` to a browser at an address with no file |
| `cacheControl` | `"no-cache"` | a `Cache-Control` value, or a function of the file's path below the root |
| `precompressed` | `false` | `true` sends the `.br` or `.gz` copy to a client that takes it |

`spa` with `notFound`, and `spa` with `index: false`, are compile errors.
`staticFiles()` throws on them too, and on a `root` that is not a
directory or a `notFound` or index file that is missing, so a mistake stops
the application at startup rather than on a request.

The package also exports the types `StaticOptions`, `StaticHandler`,
`NotFoundPage` and `SinglePageApp`.
