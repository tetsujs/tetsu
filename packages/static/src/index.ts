/**
 * Static files: a built site, a single-page app or a directory of assets,
 * served from inside the pipeline.
 *
 * ```ts
 * createApp({ routes, fallback: staticFiles({ root: "./dist", notFound: "404.html" }) });
 *
 * route({ method: "GET", path: "/assets/*", handler: staticFiles({ root: "./public" }) });
 * ```
 *
 * `staticFiles()` returns a handler, which goes wherever a handler goes,
 * so the application's hooks apply to files as to everything else:
 * security headers, CORS, a request log. Bun's own static routes are
 * faster, and skip all of that. They answer before any hook runs, serve
 * `.env` and `.git` like any other file, answer `POST` with the file, and
 * send no `Cache-Control`.
 *
 * Bun still does the sending: the length, `HEAD` and `Range` are its own.
 * What it lacks is here: the path checked before the disk is touched,
 * `ETag` and `Last-Modified` with `304`, the content type on `HEAD`,
 * directories, a not-found page, and precompressed copies, since Bun
 * compresses nothing.
 *
 * @module
 */

import type { Stats } from "node:fs";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BaseCtx } from "@tetsujs/core";
import { httpError } from "@tetsujs/core";
import type {
  DocumentedHeader,
  DocumentedResponse,
  HandlerDocs,
} from "@tetsujs/openapi";
import { documented } from "@tetsujs/openapi";
import { entityTag, isFresh, rangeHolds } from "./conditional.ts";
import type { Encoding } from "./negotiation.ts";
import { acceptedEncodings, acceptsHtml, encodings } from "./negotiation.ts";
import type { FilePath } from "./path.ts";
import { filePath } from "./path.ts";

/**
 * Where the files are and how they are answered.
 *
 * `notFound` and `spa` both answer a browser that asked for a path with
 * no file, so a site has one or the other: see {@link NotFoundPage} and
 * {@link SinglePageApp}.
 */
export type StaticOptions = FileOptions & (NotFoundPage | SinglePageApp);

/** The options of every kind of site. */
interface FileOptions {
  /**
   * The directory served.
   *
   * A relative path is resolved against the working directory, as
   * `Bun.file` resolves one, not against the module that calls
   * `staticFiles()`: `join(import.meta.dir, "public")` is the module's.
   * Checked when the handler is made: a root that does not exist, or is
   * not a directory, is refused at startup rather than on the first
   * request.
   */
  readonly root: string;

  /**
   * The file a directory is answered with: `index.html` by default.
   *
   * `/docs/` is `docs/index.html`, and `/docs` is redirected to `/docs/`
   * with `301`, so the relative links in the page resolve from the
   * directory. `false` answers a directory as a path with no file.
   */
  readonly index?: string | false;

  /**
   * `Cache-Control` of every file: `no-cache` by default, or a function of
   * the file's path below the root, such as `assets/app.3f2a.js`.
   *
   * `no-cache` lets a browser keep a file and makes it ask whether the file
   * changed before using it, which costs a `304` when it has not. Without
   * the header, a browser guesses how long to keep a file from its
   * `Last-Modified`, and goes on running an old script after a deploy. A
   * file whose name changes with its content can be kept for good:
   *
   * ```ts
   * cacheControl: (path) =>
   *   path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
   * ```
   *
   * The path is the file's, not the address's. The shell of a single-page
   * app is `index.html` at every address it answers, so a rule for `.html`
   * covers it, where a rule by address would keep `/orders/42` for a year.
   */
  readonly cacheControl?: string | ((path: string) => string);

  /**
   * Whether a client whose `Accept-Encoding` takes it gets the compressed
   * copy beside a file: `app.js.br`, then `app.js.gz`.
   *
   * Bun compresses nothing on its own, and a bundle is the largest
   * response a site sends; the build makes the copies once. A copy goes out
   * with `Content-Encoding` and the original's `Content-Type`. Its
   * `ETag`, `Last-Modified`, length and ranges are its own, as they
   * describe the bytes sent. A copy older than its original is left over
   * from an earlier build, and is not sent.
   *
   * Every file then carries `Vary: Accept-Encoding`, compressed or not, so
   * a cache keeps the copies apart. A file without copies costs up to two
   * more `stat` calls.
   */
  readonly precompressed?: boolean;
}

/** A site with a page of its own for a path that has no file. */
export interface NotFoundPage {
  /**
   * A file below the root, sent with `404` to a browser that asked for a
   * path with no file: one whose `Accept` names `text/html`.
   *
   * Any other client, `fetch` and curl among them, gets the application's
   * `404`, so a mistyped API address is not answered with a page. Both
   * carry `Vary: Accept`. Without `notFound`, every client gets the
   * application's `404`. Checked when the handler is made, as `root` is.
   */
  readonly notFound?: string;

  /** A single-page app has no not-found page: see {@link SinglePageApp}. */
  readonly spa?: false;
}

/**
 * A single-page app, whose router reads the address in the browser: every
 * address it knows must load the app.
 */
export interface SinglePageApp {
  /**
   * Answers a browser's request for a path with no file with the root's
   * `index` file and `200`, so a reload on `/orders/42` loads the app and
   * its router shows the order.
   *
   * A request that does not accept HTML still gets the application's
   * `404`: a missing script, an API address. Both carry `Vary: Accept`.
   * The app's router shows its own page for an address it does not know.
   */
  readonly spa: true;

  /** The app shows what is not found itself. */
  readonly notFound?: undefined;

  /** The shell is the root's `index` file, so there must be one. */
  readonly index?: string;
}

/**
 * What `staticFiles()` returns: a handler for `fallback` or for a route,
 * typed by the context every request has.
 */
export type StaticHandler = (ctx: BaseCtx) => Promise<Response>;

/**
 * Makes the handler that answers a request with a file below `root`.
 *
 * In `fallback`, the whole path names the file: `/css/site.css` is
 * `root/css/site.css`. On a route, what follows its `*` does:
 * `/assets/app.css` under `/assets/*` is `root/app.css`, and a route
 * without `*`, such as `/robots.txt`, names its own path. The route's
 * group, hooks and `docs` apply as to any other.
 *
 * - **A path with no file** is a `404`: the application's, thrown as an
 *   `HttpError` through its error handling, or, to a browser, the
 *   `notFound` page or the `spa` shell. So is a path refused before the
 *   disk is touched: one that leaves the route's prefix once Bun has
 *   resolved its `.` and `..`, an encoded `/` or `\`, an empty segment, a
 *   NUL, and a dotfile other than `.well-known`.
 * - **`OPTIONS`** is a `204` with `Allow: GET, HEAD, OPTIONS` where a file
 *   exists, as a route answers it, and any other method besides `GET` and
 *   `HEAD` a `405` with the same `Allow`. Where no file exists, both are a
 *   `404`, so a `POST` to a mistyped API address is the `404` it would be
 *   without files. On a route, the core answers these methods before the
 *   handler runs.
 * - **Symbolic links** are followed, as nginx, Caddy and Express follow
 *   them. What the root links to is served as part of it.
 * - **Everything below the root is public**, however its path is written.
 *   Bun's router matches a path as it arrives, the handler reads it
 *   resolved and decoded, and the disks of macOS and Windows ignore case:
 *   `/x/../reports/q3`, `/%72eports/q3` and `/REPORTS/q3` miss a guarded
 *   `/reports/*` and reach the fallback or a broader route. Files behind a
 *   guard live in a directory of their own, served by the route with the
 *   guard, never below a root served without it.
 * - **A failure of the disk** other than a missing file, such as a
 *   permission, is thrown, and is a `500`.
 *
 * Its route is left out of the OpenAPI document. Nearly every one serves
 * a site's assets, and a generated client would get a method that cannot
 * fetch a nested file: OpenAPI has no way to say that the parameter of a
 * `*` holds slashes. `docs: { hidden: false }` on the route shows it, as
 * the handler describes it: a file of any type with its headers, `206`,
 * `304`, `404` and `416`.
 *
 * The handler returns a `Response`, so it can be wrapped. The route then
 * mounts the arrow, which tells the document nothing, and hides itself:
 *
 * ```ts
 * const files = staticFiles({ root: "./exports" });
 *
 * route({
 *   method: "GET",
 *   path: "/downloads/*",
 *   docs: { hidden: true },
 *   handler: (ctx) => {
 *     ctx.out.headers.set("content-disposition", "attachment");
 *     return files(ctx);
 *   },
 * });
 * ```
 *
 * @example A built site next to the API, and a single-page app
 * ```ts
 * createApp({
 *   routes,
 *   fallback: staticFiles({ root: "./dist", notFound: "404.html", precompressed: true }),
 * });
 *
 * createApp({ routes, fallback: staticFiles({ root: "./dist", spa: true }) });
 * ```
 */
export function staticFiles(options: StaticOptions): StaticHandler {
  const settings = settle(options);

  const handler: StaticHandler = (ctx) => answer(settings, ctx);

  return documented(handler, describe(settings));
}

/** The options, checked, with what can be resolved before a request. */
interface Settings {
  /** The root, absolute. */
  readonly root: string;

  /** The root with a separator after it, which every path served starts with. */
  readonly inside: string;

  readonly index: string | false;
  readonly page: Page | undefined;
  readonly cacheControl: (path: string) => string;
  readonly precompressed: boolean;
}

/** What answers a browser's request for a path with no file. */
interface Page {
  /** The file, absolute. */
  readonly path: string;

  /** The file below the root, with `/` between segments. */
  readonly name: string;

  /** Its media type without parameters, for the document. */
  readonly type: string;

  /** `404` for a not-found page, `200` for the shell of an app. */
  readonly status: 200 | 404;
}

/** A file to send. */
interface Found {
  /** The file, absolute. */
  readonly path: string;

  /**
   * The file below the root, with `/` between segments: what
   * `cacheControl` is given.
   */
  readonly name: string;

  readonly stats: Stats;
}

/** A compressed copy of a file. */
interface Copy {
  readonly path: string;
  readonly stats: Stats;
  readonly encoding: Encoding;
}

/** The methods a file answers, listed as for a route that serves `GET`. */
const allow = "GET, HEAD, OPTIONS";

/**
 * What one request is answered with.
 *
 * `req.url` is not always a whole URL. Without a usable `Host`, as in an
 * HTTP/1.0 health check, Bun leaves it relative, `/index.html`, and a
 * placeholder origin goes in front of it. In front, not as a base: against
 * a base, `//x/app.js` would be another host's `/app.js`, where with a
 * `Host` it is a path with an empty segment, and refused. A `Host` such as
 * `[` makes it no URL at all, and that names no file.
 */
async function answer(settings: Settings, ctx: BaseCtx): Promise<Response> {
  const raw = ctx.req.url;
  const url = URL.parse(raw.startsWith("/") ? `http://localhost${raw}` : raw);

  if (url === null) {
    throw httpError(404);
  }

  const path = filePath(url.pathname, ctx.route?.path);
  const found = path === undefined ? undefined : locate(settings, path);
  const method = ctx.req.method;

  if (method !== "GET" && method !== "HEAD") {
    if (found === undefined) {
      throw httpError(404);
    }

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow } });
    }

    ctx.out.headers.set("allow", allow);

    throw httpError(405);
  }

  if (found === "directory") {
    return redirect(url);
  }

  if (found !== undefined) {
    return send(settings, ctx.req, found, 200);
  }

  return missing(settings, ctx);
}

/**
 * The file a checked path names, `"directory"` for the address of a
 * directory without its `/`, or `undefined` for nothing to send.
 */
function locate(
  settings: Settings,
  path: FilePath,
): Found | "directory" | undefined {
  const target = join(settings.root, ...path.segments);

  if (target !== settings.root && !target.startsWith(settings.inside)) {
    return undefined;
  }

  const stats = stat(target);

  if (stats === undefined) {
    return undefined;
  }

  if (stats.isFile()) {
    return path.directory
      ? undefined
      : { path: target, name: path.segments.join("/"), stats };
  }

  if (!stats.isDirectory() || settings.index === false) {
    return undefined;
  }

  const index = join(target, settings.index);
  const indexStats = stat(index);

  if (indexStats === undefined || !indexStats.isFile()) {
    return undefined;
  }

  if (!path.directory) {
    return "directory";
  }

  return {
    path: index,
    name: [...path.segments, settings.index].join("/"),
    stats: indexStats,
  };
}

/**
 * `301` to a directory's address with its `/`, the query kept.
 *
 * The address starts with exactly one `/`. A path that began with two,
 * `//evil.example/docs`, would otherwise be a `Location` that sends the
 * browser to another site; such a path is refused before it gets here,
 * and this holds even if it were not.
 */
function redirect(url: URL): Response {
  const location = `/${url.pathname.replace(/^\/+/, "")}/${url.search}`;

  return new Response(null, { status: 301, headers: { location } });
}

/**
 * Answers a path with no file: the page to a browser when the site has
 * one, the application's `404` to every other client.
 */
function missing(settings: Settings, ctx: BaseCtx): Response {
  const page = settings.page;

  if (page === undefined) {
    throw httpError(404);
  }

  ctx.out.headers.append("vary", "Accept");

  if (!acceptsHtml(ctx.req)) {
    throw httpError(404);
  }

  const stats = stat(page.path);

  if (stats === undefined || !stats.isFile()) {
    throw httpError(404);
  }

  return send(
    settings,
    ctx.req,
    { path: page.path, name: page.name, stats },
    page.status,
  );
}

/**
 * A file in a response: its compressed copy when the client takes one, or
 * a `304` when the client's copy is still the file.
 *
 * Bun cuts a `Range` out of any file sent with `200`. When `If-Range` says
 * the client's part belongs to another file, the whole one goes out as a
 * stream, which Bun leaves whole, without a length.
 *
 * `Accept-Ranges` goes only to a request without `Range`. Bun sends its own
 * with the `206` or `416` it makes of one, and the header would be there
 * twice.
 */
function send(
  settings: Settings,
  req: Request,
  file: Found,
  status: 200 | 404,
): Response {
  const copy = settings.precompressed ? compressedCopy(req, file) : undefined;
  const sent = copy ?? file;
  const tag = entityTag(sent.stats.size, sent.stats.mtimeMs);
  const headers = new Headers({
    "cache-control": settings.cacheControl(file.name),
    etag: tag,
  });

  if (settings.precompressed) {
    headers.set("vary", "Accept-Encoding");
  }

  if (status === 200 && isFresh(req, tag, sent.stats.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-type", Bun.file(file.path).type);
  headers.set("last-modified", new Date(sent.stats.mtimeMs).toUTCString());

  if (copy !== undefined) {
    headers.set("content-encoding", copy.encoding);
  }

  const body = Bun.file(sent.path);

  if (status !== 200) {
    return new Response(body, { status, headers });
  }

  if (!req.headers.has("range")) {
    headers.set("accept-ranges", "bytes");

    return new Response(body, { status, headers });
  }

  if (!rangeHolds(req, sent.stats.mtimeMs)) {
    return new Response(body.stream().pipeThrough(new TransformStream()), {
      status,
      headers,
    });
  }

  return new Response(body, { status, headers });
}

/**
 * The compressed copy beside a file that the client takes most, if one
 * exists and is no older than the file.
 */
function compressedCopy(req: Request, file: Found): Copy | undefined {
  for (const encoding of acceptedEncodings(req)) {
    const path = `${file.path}${encodings[encoding]}`;
    const stats = stat(path);

    if (stats?.isFile() && stats.mtimeMs >= file.stats.mtimeMs) {
      return { path, stats, encoding };
    }
  }

  return undefined;
}

/**
 * The codes of a `stat` that finds nothing: no such entry, a file where a
 * directory was expected on the way, a name too long to exist.
 */
const absent: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/**
 * What is at `path`, links followed, or `undefined` for nothing. Any other
 * failure is thrown.
 *
 * Synchronous on purpose. Through the whole pipeline, with Bun sending
 * the file, an asynchronous `stat` cost 48 µs of processor time per
 * request against 32, and served 29% fewer requests a second (Bun 1.4.2,
 * Apple M5 Pro). The call itself takes under a microsecond on a local
 * disk with the file in the cache. The price is that a slow disk, such as
 * one on the network, holds the thread for as long as it takes to answer.
 */
function stat(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (absent.has((error as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }

    throw error;
  }
}

/** The options as a caller the types did not reach may pass them. */
interface LooseOptions {
  readonly root?: unknown;
  readonly index?: unknown;
  readonly notFound?: unknown;
  readonly spa?: unknown;
  readonly cacheControl?: unknown;
  readonly precompressed?: unknown;
}

/**
 * Checks the options and resolves what can be resolved before the first
 * request. Typed loosely on purpose: it is what holds for a caller the
 * types did not reach, such as plain JavaScript.
 */
function settle(options: StaticOptions): Settings {
  const loose: LooseOptions = options;

  if (typeof loose.root !== "string" || loose.root === "") {
    throw new Error(
      `staticFiles: root must be the path of a directory, got ${shown(loose.root)}`,
    );
  }

  const root = resolve(loose.root);
  const rootStats = stat(root);

  if (rootStats === undefined || !rootStats.isDirectory()) {
    throw new Error(
      `staticFiles: root ${JSON.stringify(loose.root)} is ${root}, which ${rootStats === undefined ? "does not exist" : "is not a directory"} — a relative root is resolved against the working directory, ${process.cwd()}`,
    );
  }

  const index = loose.index ?? "index.html";

  if (index !== false && !isFileName(index)) {
    throw new Error(
      `staticFiles: index must be the name of a file, such as "index.html", or false, got ${shown(index)}`,
    );
  }

  if (loose.spa !== undefined && typeof loose.spa !== "boolean") {
    throw new Error(
      `staticFiles: spa must be true or false, got ${shown(loose.spa)}`,
    );
  }

  if (
    loose.precompressed !== undefined &&
    typeof loose.precompressed !== "boolean"
  ) {
    throw new Error(
      `staticFiles: precompressed must be true or false, got ${shown(loose.precompressed)}`,
    );
  }

  return {
    root,
    inside: root.endsWith(sep) ? root : `${root}${sep}`,
    index,
    page: pageOf(root, loose, index),
    cacheControl: cacheControlOf(loose.cacheControl),
    precompressed: loose.precompressed === true,
  };
}

/** The page of a site with `notFound` or `spa`, checked to be a file. */
function pageOf(
  root: string,
  options: LooseOptions,
  index: string | false,
): Page | undefined {
  if (options.spa === true) {
    if (options.notFound !== undefined) {
      throw new Error(
        "staticFiles: spa and notFound both answer a browser's request for a path with no file — a single-page app answers it with its shell, and its router shows what is not found; give one of them",
      );
    }

    if (index === false) {
      throw new Error(
        "staticFiles: spa answers with the root's index file, and index is false",
      );
    }

    return checkedPage(
      root,
      index,
      200,
      `the index file ${JSON.stringify(index)} that spa answers with`,
    );
  }

  if (options.notFound === undefined) {
    return undefined;
  }

  if (typeof options.notFound !== "string" || options.notFound === "") {
    throw new Error(
      `staticFiles: notFound must be the path of a file below the root, got ${shown(options.notFound)}`,
    );
  }

  return checkedPage(
    root,
    options.notFound,
    404,
    `notFound ${JSON.stringify(options.notFound)}`,
  );
}

/** A page's file, refused when it is outside the root or is not a file. */
function checkedPage(
  root: string,
  name: string,
  status: 200 | 404,
  subject: string,
): Page {
  const path = resolve(root, name);
  const below = relative(root, path);

  if (
    below === "" ||
    below === ".." ||
    below.startsWith(`..${sep}`) ||
    isAbsolute(below)
  ) {
    throw new Error(`staticFiles: ${subject} is outside the root, ${root}`);
  }

  const stats = stat(path);

  if (stats === undefined || !stats.isFile()) {
    throw new Error(
      `staticFiles: ${subject} is ${path}, which ${stats === undefined ? "does not exist" : "is not a file"}`,
    );
  }

  return {
    path,
    name: below.split(sep).join("/"),
    type: Bun.file(path).type.split(";")[0] ?? "",
    status,
  };
}

/** `cacheControl` as a function, a string checked to be a header value. */
function cacheControlOf(value: unknown): (path: string) => string {
  if (value === undefined) {
    return () => "no-cache";
  }

  if (typeof value === "function") {
    return value as (path: string) => string;
  }

  if (typeof value !== "string" || value === "") {
    throw new Error(
      `staticFiles: cacheControl must be a Cache-Control value or a function of the file's path, got ${shown(value)}`,
    );
  }

  try {
    new Headers({ "cache-control": value });
  } catch {
    throw new Error(
      `staticFiles: cacheControl ${JSON.stringify(value)} cannot be the value of a header`,
    );
  }

  return () => value;
}

/** Whether a value names a file in a directory: no separator, no `..`. */
function isFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/** A value as an error message shows it. */
function shown(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  const kind = typeof value;

  return kind === "object" ? "an object" : `a ${kind}`;
}

/**
 * What the handler answers, for `@tetsujs/openapi`: as much as the options
 * tell before any request, and hidden until the route says otherwise.
 *
 * The type of a file is known only when it is asked for, so a file is
 * any type, `*` over `*`.
 */
function describe(settings: Settings): HandlerDocs {
  const text = { type: "string" } as const;
  const validators: Record<string, DocumentedHeader> = {
    etag: { description: "Changes when the file changes", schema: text },
    "cache-control": {
      description: "How long the file may be kept",
      schema: text,
    },
  };
  const file: Record<string, DocumentedHeader> = {
    ...validators,
    "last-modified": {
      description: "When the file last changed",
      schema: text,
    },
    "accept-ranges": {
      description: "A part of the file can be asked for with Range",
      schema: { type: "string", const: "bytes" },
    },
  };
  const range: Record<string, DocumentedHeader> = {
    "content-range": {
      description: "Which bytes of the file are sent, and its length",
      schema: text,
    },
  };
  const varied: Record<string, DocumentedHeader> = settings.precompressed
    ? { vary: { description: "Accept-Encoding", schema: text } }
    : {};
  const compression: Record<string, DocumentedHeader> = settings.precompressed
    ? {
        "content-encoding": {
          description: "The compression of the copy sent, when one was",
          schema: { type: "string", enum: Object.keys(encodings) },
        },
        ...varied,
      }
    : {};
  const byAccept: Record<string, DocumentedHeader> =
    settings.page === undefined
      ? {}
      : {
          vary: {
            description:
              "Accept: a browser gets a page, another client the error",
            schema: text,
          },
        };

  const responses: DocumentedResponse[] = [
    {
      status: 200,
      description: "The file",
      contentType: "*/*",
      headers: { ...file, ...compression },
    },
    {
      status: 206,
      description: "The part of the file that Range asked for",
      contentType: "*/*",
      headers: { ...range, ...file, ...compression },
    },
  ];

  if (settings.index !== false) {
    responses.push({
      status: 301,
      description: "The address of a directory, with its trailing slash",
      headers: {
        location: { description: "The directory's address", schema: text },
      },
    });
  }

  responses.push(
    {
      status: 304,
      description: "The client's copy is still the file",
      headers: { ...validators, ...varied },
    },
    {
      status: 404,
      description: "No such file",
      error: "NOT_FOUND",
      ...(settings.page === undefined ? {} : { headers: byAccept }),
    },
  );

  if (settings.page?.status === 404) {
    responses.push({
      status: 404,
      description: "The site's not-found page, to a browser",
      contentType: settings.page.type,
      headers: { ...file, ...compression, ...byAccept },
    });
  }

  responses.push({
    status: 416,
    description: "The range asked for lies outside the file",
    contentType: "*/*",
    headers: { ...range, ...file, ...compression },
  });

  return { hidden: true, responses };
}
