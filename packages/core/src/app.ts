/**
 * Application assembly.
 *
 * `createApp()` compiles the topology tree into a route table and exposes it
 * the way Bun serves it: `Bun.serve({ ...app, port })`.
 *
 * Routing is Bun's, entirely. Every declared path becomes one native route
 * registered as a plain function, so Bun's router — not ours — decides which
 * path a URL belongs to, decodes it and extracts `params`. The function then
 * dispatches on the method against a table precomputed for that exact path,
 * which needs no matching at all: the declared method runs its pipeline,
 * `HEAD` reuses the `GET` pipeline with the body stripped, `OPTIONS` answers
 * from the path's `Allow` set, and anything else is a `405` with the same
 * set. `fetch` is reached only when no path matched, so it is the `404`.
 *
 * Protocol responses are not dead ends: `404`, `405` and `OPTIONS` all run
 * through the pipeline carrying the **application-level** hook chains. That
 * makes app-wide observers see requests nothing handled, lets a CORS hook
 * answer a preflight, and keeps zone guards away from those requests — an
 * authentication hook on `/admin` must not reject a browser preflight.
 *
 * Keeping a second matcher of our own was the previous design; it produced a
 * class of defects where the two disagreed — tests exercising one path while
 * production served the other. One router means that class cannot exist.
 *
 * The consequence is that `app.fetch` no longer routes: integration tests go
 * through a real `Bun.serve` (see `test-utils/server.ts`), which is what
 * production does anyway and costs ~0.07 ms per request.
 *
 * @module
 */

import type { CookieMap, Server, WebSocketHandler } from "bun";
import type { BaseCtx } from "./context.ts";
import type { CookieOptions } from "./cookie.ts";
import { cookieSealer } from "./cookie.ts";
import { errorBody } from "./error.ts";
import type { GroupHooks } from "./group.ts";
import { slotHooks } from "./group.ts";
import { appBrand, onMount } from "./mount.ts";
import type { Executable, PipelineOptions } from "./pipeline.ts";
import { release, runPipeline } from "./pipeline.ts";
import type { ReportError } from "./report.ts";
import { reporter } from "./report.ts";
import type { Method } from "./route.ts";
import type { SocketState } from "./socket.ts";
import { socketHandler } from "./socket.ts";
import type {
  GroupHooksInput,
  LevelExt,
  ValidateGroupHooksInput,
} from "./stack.ts";
import type {
  RouteMap,
  RoutesOf,
  RouteTable,
  RouteTableEntry,
} from "./table.ts";
import { buildRouteTable } from "./table.ts";

/**
 * The configuration accepted by `createApp()`.
 */
export interface AppConfig<
  H extends GroupHooksInput = GroupHooks,
  R = object | readonly object[],
> {
  /**
   * Application-wide hooks, keyed by slot and prepended to every route's
   * chains. Validated like group hooks: a hook may require what its slot
   * guarantees and what the application's hooks before it contributed.
   */
  readonly hooks?: H & ValidateGroupHooksInput<H>;

  /** The topology: a group, a controller, or an array of either. */
  readonly routes: R;

  readonly validation?: {
    /**
     * Status for schema validation failures. The default `422` follows the
     * FastAPI/Rails school; teams using the "400 = contract" convention set
     * `400`. Malformed JSON is always `400` regardless.
     */
    readonly status?: 400 | 422;
  };

  /**
   * Whether handler results are checked against `schema.response` at
   * runtime. Defaults to `true`.
   *
   * The check is a contract *and* a transformation: the value the validator
   * returns is what gets serialized, so a schema that strips unknown keys
   * is what stops a field like `passwordHash` from leaving the process —
   * structural typing cannot, because a handler returning
   * `User & { passwordHash }` satisfies the declared type. A declared
   * schema behaves identically in every environment; the framework never
   * consults `NODE_ENV`.
   *
   * `false` turns the runtime check off entirely. The schema keeps working
   * for free at the other two levels — it still checks the handler's return
   * type at compile time and still documents the contract. Validating
   * outside production only is a decision for the composition root:
   *
   * ```ts
   * validateResponses: Bun.env.NODE_ENV !== "production"
   * ```
   *
   * Handlers returning a raw `Response` are never checked: the framework
   * does not inspect a response it did not build.
   */
  readonly validateResponses?: boolean;

  /**
   * Maximum request body size in bytes for routes that declare a `body`
   * schema. Defaults to 1 MiB.
   *
   * A `content-length` above the limit is rejected with a `413` before a
   * single byte is read; a chunked request is dropped as soon as the
   * buffered stream crosses the limit. Either way an oversized body costs
   * no parsing and no validation.
   *
   * The chunked rejection abandons the stream mid-flight, which leaves the
   * connection's framing broken: the client gets its `413`, but that
   * connection is spent and the next request over it fails. Declared
   * bodies are read to the end and cost the connection nothing.
   *
   * The framework only guards the body it parses itself: a handler reading
   * `ctx.req` directly is not capped. The ceiling for everything else is
   * Bun's own `maxRequestBodySize` (default 128 MB), set where the app is
   * served: `Bun.serve({ ...app, maxRequestBodySize })`.
   */
  readonly maxBodySize?: number;

  /**
   * How cookies are signed, when they are.
   *
   * Configuration rather than schema: a secret is not a shape, so it has
   * no place in a route's `schema.cookies`, and the policy is the
   * application's rather than any one endpoint's. A covered cookie is
   * sealed on the way out and verified on the way in without a call site
   * mentioning it, which is the point — a signature nobody can forget to
   * apply.
   *
   * @example
   * ```ts
   * createApp({ cookies: { secret: env.COOKIE_SECRET, sign: ["session"] }, routes });
   * ```
   */
  readonly cookies?: CookieOptions;

  /**
   * Answers requests whose path matched no route, replacing the default
   * `404` response entirely. Runs with the application-level hook chains.
   *
   * The result is serialized like a handler result: status `200` (or `204`
   * for `undefined`) unless the fallback sets `ctx.out.status` or returns a
   * `Response`. An SPA index wants exactly that; a custom `404` body must
   * state its status itself.
   *
   * @example An SPA index (200) and a custom 404
   * ```ts
   * createApp({
   *   routes,
   *   fallback: (ctx) =>
   *     new Response(indexHtml, { headers: { "content-type": "text/html" } }),
   * });
   *
   * createApp({
   *   routes,
   *   fallback: (ctx) => {
   *     ctx.out.status = 404;
   *     return errorBody(404, "NO_SUCH_ROUTE");
   *   },
   * });
   * ```
   */
  readonly fallback?: FallbackHandler;

  /**
   * Receives every failure no response can carry — an error no `onError`
   * hook answered, a handler breaking its response contract, a hook
   * failing after the response went, a WebSocket handler, a stream — in
   * place of `console.error`.
   *
   * `ctx` is typed from this application's own hooks, each field optional:
   * the failure may have come before the hook that contributes it ran. It
   * is absent where there was no request. See `FailureReport` for what a
   * report carries and `FailureSource` for the sources.
   *
   * Without it, the framework prints what it always printed.
   *
   * @example Into the application's logger, joined to the access log
   * ```ts
   * createApp({
   *   hooks: {
   *     beforeParse: [requestId()],
   *     afterResponse: [accessLog({ write: (r) => logger.info(r) })],
   *   },
   *   reportError: ({ source, error, ctx }) =>
   *     logger.error({ err: error, source, requestId: ctx?.requestId }, "tetsu"),
   *   routes,
   * });
   * ```
   */
  readonly reportError?: ReportError<AppContext<H>>;
}

/**
 * The context of a request as the application sees it: the base fields,
 * and what the application's own hooks contribute before the handler, each
 * optional.
 *
 * Unlike a controller, `createApp` knows its hooks — they are written in
 * the same call — so what reads the context there can be typed by them.
 * Optional because a failure can come before the hook that contributes a
 * field has run. What routes and groups contribute is on the object too,
 * untyped: the application does not know which route a request took.
 */
export type AppContext<H> =
  unknown extends LevelExt<H> ? BaseCtx : BaseCtx & Partial<LevelExt<H>>;

/**
 * Handles a request that matched no route. Receives the same context shape
 * as an early hook: the raw request and the response settings, plus
 * whatever application-level hooks contributed.
 */
export type FallbackHandler = (ctx: BaseCtx) => unknown | Promise<unknown>;

/**
 * A request whose path already matched a route; `params` is filled in by
 * Bun's router, and `cookies` is Bun's `CookieMap` — mutations to it are
 * applied to the response as `Set-Cookie` automatically.
 */
export type RoutedRequest = Request & {
  readonly params: Record<string, string>;
  readonly cookies: CookieMap;
};

/**
 * Handles every method of one declared path.
 *
 * Resolves to nothing when the request became a WebSocket: the upgrade is
 * the answer, and Bun expects no response after it.
 *
 * Returns the response itself when nothing along the way waited, and a
 * promise of it otherwise — the pipeline is synchronous until a stage is
 * not. `await` handles both.
 */
export type PathHandler = (
  req: RoutedRequest,
  server: Server<unknown>,
) => Response | undefined | Promise<Response | undefined>;

/**
 * A built application.
 *
 * Serve it by spreading into `Bun.serve` — the object carries both halves
 * and cannot be wired up half-way:
 *
 * ```ts
 * Bun.serve({ ...app, port: 3000 });
 * ```
 */
/**
 * The options an application runs with, every default filled in.
 *
 * Exposed as `app.options` so tooling reads the values actually in force
 * instead of restating them: a documentation generator has to know which
 * status validation failures carry before it can describe them, and
 * restating `422` on its own side is how documentation drifts.
 *
 * The reporter is left out: it is the application's own `reportError`,
 * not a value for tooling to read.
 */
export type AppOptions = Omit<PipelineOptions, "report">;

declare const routesBrand: unique symbol;

export interface App<Routes extends RouteMap = RouteMap> {
  /** Marks a built application, so it can be told from a controller. */
  readonly [appBrand]: true;

  /**
   * The routes this application serves, carried in the type alone.
   *
   * A phantom field, like the one a hook carries for its context: it holds
   * no value at runtime, and exists so that two applications serving
   * different routes are different types rather than structurally equal.
   * Read it with {@link AppRoutes}, not by hand.
   */
  readonly [routesBrand]?: Routes;

  /**
   * The no-match handler, reached only when Bun's router matched no path.
   *
   * It does not route: calling it directly always takes the fallback path.
   * To exercise an application in tests, serve it
   * (`test-utils/server.ts`).
   */
  readonly fetch: (req: Request, server: Server<unknown>) => Promise<Response>;

  /** Native route map: one handler per declared path. */
  readonly routes: Record<string, PathHandler>;

  /**
   * Bun's own body cap, raised to sit above this application's, and
   * present only when it had to be.
   *
   * `Bun.serve` refuses a body over `maxRequestBodySize` before a request
   * reaches any of this — with a bare `413`, not the framework's envelope
   * — and its default is 128 MiB. An application that allows more than
   * that would otherwise need the number in two places, one of them not
   * ours, and would discover the omission as a status with an empty body.
   *
   * Carried on the app so that `Bun.serve({ ...app })` picks it up with
   * everything else. Placing a value after the spread still wins, because
   * that is what spreading means.
   *
   * It is only ever raised, never lowered: a route that streams its body
   * reads past `maxBodySize` on purpose, and a cap derived downwards would
   * cut exactly the uploads that were meant to be large.
   */
  readonly maxRequestBodySize?: number;

  /**
   * The WebSocket handler of every socket endpoint in the table.
   *
   * Always present, even when nothing declares a socket: `Bun.serve` only
   * lets a route hand a connection over when the server has one, and an
   * application whose type depended on whether it happens to contain a
   * socket endpoint would be a worse trade than an inert handler.
   *
   * Bun's server-level options — `idleTimeout`, `maxPayloadLength`,
   * `backpressureLimit` — are not proxied, for the same reason `tls` is
   * not: spread what you need over it.
   *
   * ```ts
   * Bun.serve({ ...app, websocket: { ...app.websocket, idleTimeout: 30 } });
   * ```
   */
  readonly websocket: WebSocketHandler<SocketState>;

  /**
   * The compiled route table, for diagnostics and tooling.
   *
   * The runtime half of what the type parameter carries: `entries` is what
   * the table found, `Routes` is what the types remember of the same
   * walk — the method, full path and schemas of every route, keyed by
   * `"METHOD /full/path"`. A generated client reads the second; a route
   * listing reads the first.
   */
  readonly entries: readonly RouteTableEntry[];

  /** The resolved options this application runs with. */
  readonly options: AppOptions;

  /** Prints the route table: method, full path, owning controller. */
  readonly printRoutes: () => void;
}

/**
 * Compiles the topology into a servable application.
 *
 * Fails at startup on topology mistakes (duplicate `method + path`);
 * non-fatal findings (a controller without routes) are reported via
 * `console.warn`.
 *
 * @example
 * ```ts
 * const app = createApp({
 *   routes: group("/api/v1", {
 *     children: [usersController({ users })],
 *   }),
 * });
 *
 * Bun.serve({ ...app, port: 3000 });
 * ```
 */
/**
 * The routes an application carries, read off its type.
 *
 * What a generated client starts from: `AppRoutes<typeof app>` is the map
 * of every endpoint the application serves, keyed by method and full path.
 */
export type AppRoutes<A> = A extends App<infer Routes> ? Routes : never;

export function createApp<
  const R extends object | readonly object[],
  const H extends GroupHooksInput = GroupHooks,
>(config: AppConfig<H, R>): App<RoutesOf<R>> {
  const table = buildRouteTable({
    routes: config.routes,
    hooks: slotHooks(config.hooks, "createApp()"),
  });

  for (const warning of table.warnings) {
    console.warn(`[tetsu] ${warning}`);
  }

  const settings: AppOptions = {
    validationStatus: config.validation?.status ?? 422,
    validateResponses: config.validateResponses ?? true,
    maxBodySize: config.maxBodySize ?? defaultMaxBodySize,
    ...(config.cookies === undefined
      ? {}
      : { cookieSealer: cookieSealer(config.cookies) }),
  };

  const options: PipelineOptions = {
    ...settings,
    report: reporter(config.reportError),
  };

  const protocolEntry = (handler: (ctx: never) => unknown): Executable => ({
    hooks: table.appHooks,
    def: { handler },
  });

  const fallback = protocolEntry(
    (config.fallback ?? notFound) as (ctx: never) => unknown,
  );

  const app: App<RoutesOf<R>> = {
    [appBrand]: true,
    ...bunBodyCap(options.maxBodySize, table.entries),
    fetch: async (req, server) =>
      (await runPipeline(fallback, req, server, {}, options)) ??
      new Response(null, { status: 204 }),
    websocket: socketHandler(options.report),
    routes: buildRoutes(table, options, protocolEntry),
    entries: table.entries,
    options: settings,
    printRoutes: () => {
      for (const entry of table.entries) {
        console.log(
          `${entry.method.padEnd(6)} ${entry.path}  → ${entry.controller ?? "—"}`,
        );
      }
    },
  };

  /**
   * The loop closed: a controller that documents or enumerates the
   * application receives it here, after the table is compiled and before
   * anything is served. It runs at startup, so a controller that throws
   * takes the process down with it rather than failing on a request.
   */
  for (const controller of table.mounted) {
    controller[onMount](app);
  }

  return app;
}

/**
 * Default `maxBodySize`: 1 MiB. Generous for JSON APIs — a typical payload
 * is kilobytes — while keeping an unauthenticated flood of large bodies
 * from turning into memory pressure by default.
 */
const defaultMaxBodySize = 1_048_576;

/** What `Bun.serve` allows when nobody says otherwise. */
const bunDefaultBodyCap = 134_217_728;

/**
 * Room for the chunk that crosses the line.
 *
 * Both limits count the same bytes, so setting Bun's to exactly ours makes
 * the two a race, and Bun winning means a bare `413` where the framework
 * had an envelope ready. A margin puts the framework's check first every
 * time, and leaves Bun's as the backstop it should be.
 */
const bodyCapMargin = 1_048_576;

/**
 * Bun's cap for an application that allows more than Bun does by default.
 *
 * Nothing when the application's limit is below Bun's: raising it would be
 * pointless and lowering it would break the routes that read their body as
 * a stream, which pass `maxBodySize` deliberately.
 */
function bunBodyCap(
  maxBodySize: number,
  entries: readonly RouteTableEntry[],
): { maxRequestBodySize?: number } {
  /**
   * The largest ceiling anything in this application allows, not the
   * application's own: a single route declaring a bigger `maxBodySize` is
   * exactly the case the setting exists for, and Bun would cut it before
   * the route ever saw a byte.
   */
  const allowed = entries.reduce(
    (largest, entry) => Math.max(largest, entry.def.maxBodySize ?? 0),
    maxBodySize,
  );

  const needed = allowed + bodyCapMargin;

  return needed > bunDefaultBodyCap ? { maxRequestBodySize: needed } : {};
}

function notFound(): Response {
  return Response.json(errorBody(404), { status: 404 });
}

/**
 * Builds a synthetic `Executable` for a protocol response — `404`, `405`,
 * `OPTIONS` — carrying only the application-level hook chains. The single
 * place these entries are shaped; see the module doc for why zone hooks
 * are deliberately absent.
 */
type ProtocolEntryFactory = (handler: (ctx: never) => unknown) => Executable;

function buildRoutes(
  table: RouteTable,
  options: PipelineOptions,
  protocolEntry: ProtocolEntryFactory,
): Record<string, PathHandler> {
  const byPath = new Map<string, Map<string, RouteTableEntry>>();

  for (const entry of table.entries) {
    const methods = byPath.get(entry.path) ?? new Map();

    byPath.set(entry.path, methods);
    methods.set(entry.method, entry);
  }

  const routes: Record<string, PathHandler> = {};

  for (const [path, methods] of byPath) {
    routes[path] = buildPathHandler(methods, options, protocolEntry);
  }

  return routes;
}

function buildPathHandler(
  methods: Map<string, RouteTableEntry>,
  options: PipelineOptions,
  protocolEntry: ProtocolEntryFactory,
): PathHandler {
  const allow = buildAllow(methods);
  const getEntry = methods.get("GET");

  const preflight = protocolEntry(
    () => new Response(null, { status: 204, headers: { allow } }),
  );

  const notAllowed = protocolEntry(() =>
    Response.json(errorBody(405), { status: 405, headers: { allow } }),
  );

  const head = async (
    req: RoutedRequest,
    server: Server<unknown>,
    get: RouteTableEntry,
  ): Promise<Response | undefined> => {
    const res = await runPipeline(get, req, server, req.params, options);

    if (res === undefined) {
      return undefined;
    }

    const bodiless = new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });

    release(res, bodiless);

    return bodiless;
  };

  return (req, server) => {
    const method = req.method.toUpperCase();
    const entry = methods.get(method);

    if (entry) {
      return runPipeline(entry, req, server, req.params, options);
    }

    if (method === "HEAD" && getEntry) {
      return head(req, server, getEntry);
    }

    if (method === "OPTIONS") {
      return runPipeline(preflight, req, server, req.params, options);
    }

    return runPipeline(notAllowed, req, server, req.params, options);
  };
}

function buildAllow(methods: Map<string, RouteTableEntry>): string {
  const allowed: string[] = [...methods.keys()];

  if (methods.has("GET" satisfies Method)) {
    allowed.push("HEAD");
  }

  allowed.push("OPTIONS");

  return allowed.join(", ");
}
