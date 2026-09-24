/**
 * Request context types for every stage of the request lifecycle, and the
 * runtime implementation of `Outgoing`.
 *
 * The context follows one rule: a field exists in the type if and only if it
 * exists at that point of the pipeline. Unvalidated data is not reachable —
 * `ctx.body` before validation is a compile error, not an `unknown` surprise.
 *
 * @module
 */

import type { CookieMap, Server } from "bun";
import type { CookieSealer, ResponseCookies } from "./cookie.ts";
import { responseCookies } from "./cookie.ts";
import type { ExtractParams } from "./path.ts";
import type { AnySchema, InferOutput } from "./schema.ts";

/**
 * What the response will carry: `ctx.out`.
 *
 * A noun, and deliberately. Called `set` it read as a verb doing duty as a
 * namespace, and every member then stuttered — `ctx.set.headers.set(...)`,
 * `ctx.set.cookies.set(...)`. The alternative was to wrap `Headers` in
 * methods of our own naming, which this framework does not do to platform
 * objects; renaming the namespace fixes all of them at once and leaves the
 * standard objects standard.
 *
 * It pairs with the request side by position: `ctx.headers` and
 * `ctx.cookies` are what arrived, `ctx.out.headers` and `ctx.out.cookies`
 * are what leaves.
 *
 * `status` applies when the handler result is serialized and is ignored
 * when the handler (or a hook) returns a `Response` directly — a direct
 * response states its own status, and an error's status belongs to the
 * error mapping. It is an accessor pair rather than a plain property so a
 * route can narrow what may be written without narrowing what is read:
 * see {@link DeclaredOutgoing}. `headers` apply to every response leaving the pipeline:
 * error responses, short-circuits and raw `Response`s included.
 *
 * @example
 * ```ts
 * handler: (ctx) => {
 *   ctx.out.status = 201;
 *   return { id: "42" };
 * }
 * ```
 */
export interface Outgoing {
  get status(): number | undefined;

  set status(value: number | undefined);

  /**
   * Headers applied to the outgoing response, whatever produced it —
   * `set-cookie` values are appended, any other name overwrites.
   *
   * A live standard `Headers`, created on first access. It is never
   * assigned, only mutated — `set()` to own a header, `append()` to add to
   * it — so two hooks writing headers compose instead of overwriting each
   * other's whole set.
   *
   * @example
   * ```ts
   * ctx.out.headers.set("x-request-id", id);
   * ctx.out.headers.append("set-cookie", "session=abc; HttpOnly");
   * ```
   */
  readonly headers: Headers;

  /**
   * Cookies the response will carry, written by name rather than by
   * serializing a `set-cookie` value by hand.
   *
   * The mirror of {@link Outgoing.headers}, and it stands to
   * `ctx.cookies` exactly as `ctx.out.headers` stands to `ctx.headers`:
   * what arrived on one side, what leaves on the other.
   *
   * @example
   * ```ts
   * ctx.out.cookies.set("session", token, { httpOnly: true, maxAge: 3600 });
   * ```
   */
  readonly cookies: ResponseCookies;
}

/**
 * Runtime implementation of `Outgoing`.
 *
 * `headers` is created on first access, so a request that never touches
 * headers allocates nothing. The pipeline reads `createdHeaders` to apply
 * headers to the outgoing response without triggering the allocation.
 *
 * Internal to the core and the test utilities; user code only sees the
 * `Outgoing` interface.
 */
export class OutgoingSettings implements Outgoing {
  status: number | undefined = undefined;

  /** The instance behind `headers`, if any code has accessed it. */
  createdHeaders?: Headers;

  private createdCookies?: ResponseCookies;

  /**
   * @param sealer - The application's cookie signing policy, when it has
   * one. Held rather than consulted per call so a write never has to ask
   * which cookies are sealed.
   */
  constructor(private readonly sealer?: CookieSealer) {}

  get cookies(): ResponseCookies {
    this.createdCookies ??= responseCookies(() => this.headers, this.sealer);

    return this.createdCookies;
  }

  get headers(): Headers {
    this.createdHeaders ??= new Headers();

    return this.createdHeaders;
  }
}

/**
 * The part of the context available at every lifecycle stage.
 */
export interface BaseCtx {
  /**
   * The raw incoming request, always available as an escape hatch.
   *
   * On a request that matched a route, Bun's router delivers its own
   * request object carrying `cookies` — a `Bun.CookieMap` whose mutations
   * are applied to the response as `Set-Cookie` automatically, with Bun's
   * defaults (`Path=/; SameSite=Lax`). The field is optional because it
   * does not exist where Bun's router was not involved: the `404` fallback
   * and unit-tested handlers. `ctx.out.headers.append("set-cookie", ...)`
   * is the fallback that works everywhere.
   */
  readonly req: Request & { readonly cookies?: CookieMap };

  /**
   * The server handling this request — the real `Bun.Server`, whole and
   * unguarded, like `req` an escape hatch to the platform.
   *
   * The way to reach connection- and server-level facts a `Request` does
   * not carry: `ctx.server.requestIP(ctx.req)` for rate limiting by
   * address, `ctx.server.upgrade(ctx.req)` for WebSockets,
   * `ctx.server.timeout(ctx.req, seconds)` for a per-request idle timeout.
   *
   * Deliberately not a facade: every hook is code the
   * application author wrote or vetted, and hiding `stop`/`reload` from
   * in-process code protects nothing. They are still process-level
   * operations with no business inside a request — calling
   * `ctx.server.stop()` from a hook takes the whole listener down.
   *
   * `upgrade` works only when a `websocket` handler was passed to
   * `Bun.serve` alongside the app: `Bun.serve({ ...app, websocket })`;
   * without one it throws.
   */
  readonly server: Server<unknown>;

  /** Response parameters for the serialized handler result. */
  readonly out: Outgoing;

  /**
   * The route this request matched, or nothing when none did.
   *
   * Optional because a `404`, a `405` and a preflight run the pipeline
   * too, and there is no route behind them — the same reason `req.cookies`
   * is optional. In a route's own context the field is not optional: a
   * hook mounted on a route, and its handler, always have one.
   *
   * It is the field that makes an observer able to name the endpoint
   * rather than the URL: `ctx.route.path` is `/users/:id`, where
   * `new URL(ctx.req.url).pathname` is `/users/42`. The difference is
   * cosmetic in a log line and structural in a metric, where a label built
   * from the second one grows a new series per identifier.
   */
  readonly route?: RouteInfo;

  /**
   * When the pipeline took the request: a `performance.now()` reading, in
   * milliseconds on the monotonic clock.
   *
   * `performance.now() - ctx.startedAt` is how long the request has been
   * in the framework — what an access log reports, and what a failure
   * report can say about the request it belongs to. Read once per request
   * by the core rather than by a hook in `beforeParse`: an observer needs
   * only this, so a package measuring requests is one hook after the
   * response instead of two, and the clock starts before any hook, not
   * after the ones mounted ahead of the one that reads it. It costs 7–9 ns
   * a request in the pipeline (`bench/src/cost.ts`), below the noise of
   * the HTTP benchmark.
   *
   * Wall-clock time is `Date.now()`, and not this: a monotonic reading
   * does not jump when the system clock is adjusted, which is what makes
   * a difference of two of them a duration.
   */
  readonly startedAt: number;
}

/**
 * What the application knows about an endpoint, as a request sees it.
 *
 * The values are the ones the route table computed when the application
 * was built — one object per route, shared by every request that matches
 * it, never rebuilt. The handler, the hooks and the schemas are
 * deliberately not here: this is what an observer needs to name the route,
 * not a way to reach into it. `app.entries` is the whole picture, for
 * tooling that wants it.
 */
export interface RouteInfo {
  /** The method this route answers. */
  readonly method: string;

  /**
   * The path as the route declared it, with group prefixes joined and
   * `:params` left as they are — `/api/users/:id`, never `/api/users/42`.
   */
  readonly path: string;

  /**
   * The name of the controller the route was collected from — the one
   * `controller()` gave it, or its class's. Absent for an object literal
   * and a route mounted standalone, which have nothing to be named after.
   */
  readonly controller?: string;

  /**
   * The field name the route was declared under, when it had one.
   *
   * Absent for a `RouteDef` mounted on its own, which has no field to be
   * named by. It is the same name `@tetsujs/openapi` builds an
   * `operationId` from, so a metric labelled with it and an operation in
   * the document agree on what the endpoint is called.
   */
  readonly name?: string;
}

/**
 * Declares what a reusable hook requires from the context.
 *
 * A reusable hook cannot know the concrete route it will be attached to, so
 * instead it states a contract: "give me a context with at least these
 * fields". The `route()` call site verifies that the path, the schemas and
 * the preceding hooks actually provide them — a compile error otherwise.
 *
 * @example
 * ```ts
 * const withOrder = hook.beforeHandle(
 *   async (ctx: Requires<{ params: { id: string }; user: User }>) => {
 *     const order = await orders.find(ctx.params.id);
 *     if (!order) throw new HttpError(404);
 *     return { order };
 *   },
 * );
 * ```
 */
export type Requires<T extends object> = BaseCtx & T;

/**
 * Context before parsing and validation: `beforeParse` hooks see this shape.
 *
 * Path parameters are present as raw strings; `body` and `query` do not exist
 * yet — neither at runtime nor in the type.
 */
export type EarlyCtx<Path extends string> = BaseCtx & {
  readonly params: ExtractParams<Path>;
  readonly route: RouteInfo;
};

/**
 * The wire shape of a request body, declared by the route.
 *
 * `"json"` is the default and the only shape the framework parsed before
 * this existed. `"form"` covers both `multipart/form-data` and
 * `application/x-www-form-urlencoded` — one `FormData` call handles both —
 * and `"text"` hands the body over as a string.
 *
 * `"stream"` is the one that is not parsed: `ctx.body` is the request's
 * own `ReadableStream`, and the handler reads it at whatever pace it
 * writes somewhere else. The bytes are still counted — `maxBodySize`
 * applies, and passing it ends the stream with the same `413` every other
 * shape produces — but they are never all in memory at once.
 *
 * Declaring it is the point. Reading `ctx.req.body` without declaring
 * anything does the same thing and always did, except that the opt-out is
 * then expressed by the *absence* of a line: a reader has to notice what
 * is not written, and the limit silently stops applying. A route that says
 * `"stream"` says it where it will be read.
 */
export type BodyType = "json" | "form" | "text" | "stream";

/** One value of a form field: a text field, or an uploaded file. */
export type FormValue = string | File;

/**
 * A parsed form body: field names to values, a repeated field collected
 * into an array — the same rule query parameters follow.
 *
 * Files arrive as native `File` objects and go through the route's `body`
 * schema like everything else, so a validator that can describe a file
 * (size, MIME type) describes it here.
 */
export type FormBody = Record<string, FormValue | FormValue[]>;

/**
 * The body a route receives before validation, given the shape it
 * declared. `unknown` for JSON — parsing says nothing about the result —
 * and for a route that declared no shape at all.
 */
export type ParsedBody<B> = B extends "text"
  ? string
  : B extends "form"
    ? FormBody
    : B extends "stream"
      ? ReadableStream<Uint8Array>
      : unknown;

/**
 * Validation schemas of a route. Every field is optional; an absent schema
 * means the corresponding request part is neither parsed nor validated nor
 * present in the context type.
 */
export interface SchemaConfig {
  /** Narrows path parameters beyond the default `string` (e.g. coerce to number). */
  readonly params?: AnySchema;

  /** Validates the query string; adds `ctx.query`. */
  readonly query?: AnySchema;

  /** Validates the request body; adds `ctx.body` and enables body parsing. */
  readonly body?: AnySchema;

  /** Validates request headers; adds `ctx.headers`. */
  readonly headers?: AnySchema;

  /**
   * Validates the cookies the request carries; adds `ctx.cookies`.
   *
   * Cookies arrive as one header and are a record of strings by the time
   * they get here, so they are validated exactly like `query` — the same
   * phase, the same `422`, the same collected issues. A cookie the schema
   * declares and the request does not carry is a missing field, which the
   * validator reports the way it reports any other.
   *
   * Signed cookies are verified before this runs, and one whose signature
   * does not hold is not passed on. See the `cookies` option of
   * `createApp`.
   */
  readonly cookies?: AnySchema;

  /**
   * Describes what the route responds with; checks the handler return type.
   *
   * A single schema is a status-agnostic contract: whatever the handler
   * returns is checked against it, however it set `ctx.out.status`. A
   * {@link ResponseMap} instead binds a schema to each status, and the one
   * matching the outgoing status does the checking.
   */
  readonly response?: AnySchema | ResponseMap;
}

/**
 * The statuses a route's response map declares, as numbers; `never` for a
 * single schema or no `response` at all, which bind no status.
 *
 * @example
 * ```ts
 * type S = DeclaredStatus<{ response: { 201: Order; 409: Conflict } }>;
 * //   ^? 201 | 409
 * ```
 */
export type DeclaredStatus<S extends SchemaConfig> =
  S["response"] extends AnySchema
    ? never
    : S["response"] extends infer M extends ResponseMap
      ? Extract<keyof M, number>
      : never;

/**
 * `ctx.out` as a handler sees it when its route declares a response map:
 * only a declared status can be written.
 *
 * Reading still gives any number. A hook ran before the handler and may
 * have set a status the route never declared — the runtime refuses that
 * response, and a type claiming the value must be declared would be
 * claiming the refusal cannot happen. Narrowing the write alone is also
 * what keeps an ordinary {@link Outgoing}, the one `testCtx()` builds,
 * assignable here.
 */
export interface DeclaredOutgoing<Status extends number> extends Outgoing {
  get status(): number | undefined;

  set status(value: Status | undefined);
}

/**
 * Response schemas by status code.
 *
 * The handler may return any of the declared shapes; the status it leaves
 * with — `ctx.out.status`, or `200` — selects the schema that checks it.
 * The map is also the list of statuses the route answers with: the handler
 * can only write a declared one into `ctx.out.status`, and a response
 * serialized with any other — the `200` of a handler that forgot to set
 * `201`, a status a hook wrote — is refused with a `500`, the way a body
 * that fails its schema is. Both checks are response validation, and
 * `validateResponses: false` turns both off. A `Response` the handler
 * builds itself states its own status and is not checked.
 *
 * Entries for statuses the handler never returns document the error path
 * and nothing more: an `HttpError` travels through the `onError` chain,
 * which produces its response directly, and no schema is consulted there.
 * The map is what generated documentation reads; it is not a runtime
 * contract for errors.
 *
 * `null` declares a status that carries no body — a `204`, or a `304`.
 * There is nothing to check and nothing to describe, but the status is
 * still part of what the endpoint answers, so it belongs in the map: the
 * generated document lists it, and the handler is allowed to return
 * nothing.
 *
 * @example
 * ```ts
 * schema: {
 *   response: {
 *     200: Session,
 *     422: AuthError, // documentation: thrown, never returned
 *   },
 * }
 * ```
 *
 * @example An endpoint whose answer is the absence of one
 * ```ts
 * schema: { response: { 204: null } }
 * ```
 */
export type ResponseMap = Record<number, AnySchema | null>;

/**
 * Fully validated context: `beforeHandle` hooks and the handler see this
 * shape (extended by hook contributions).
 *
 * `params` falls back to raw path strings when no `params` schema is given;
 * `query`, `body` and `headers` exist only when the corresponding schema
 * does. With a response map, `out` is narrowed to a {@link DeclaredOutgoing}
 * — here, where the field first appears, and by intersection: rebuilding
 * the finished handler context to swap one field tripled the memory the
 * compiler needs.
 *
 * @example
 * ```ts
 * type Ctx = ValidatedCtx<"/orders/:id", { body: typeof CreateOrder }>;
 * //   ^? BaseCtx & { params: { id: string }; body: { qty: number } }
 * ```
 */
export type ValidatedCtx<
  Path extends string,
  S extends SchemaConfig,
  B = undefined,
> = BaseCtx & {
  readonly route: RouteInfo;
  readonly params: S["params"] extends infer P extends AnySchema
    ? InferOutput<P>
    : ExtractParams<Path>;
} & (S["cookies"] extends infer C extends AnySchema
    ? { readonly cookies: InferOutput<C> }
    : unknown) &
  (S["query"] extends infer Q extends AnySchema
    ? { readonly query: InferOutput<Q> }
    : unknown) &
  (S["body"] extends infer Body extends AnySchema
    ? { readonly body: InferOutput<Body> }
    : [B] extends [undefined]
      ? unknown
      : { readonly body: ParsedBody<B> }) &
  (S["headers"] extends infer H extends AnySchema
    ? { readonly headers: InferOutput<H> }
    : unknown) &
  ([DeclaredStatus<S>] extends [never]
    ? unknown
    : { readonly out: DeclaredOutgoing<DeclaredStatus<S>> });
