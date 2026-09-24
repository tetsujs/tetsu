/**
 * Route definition — the assembly point of the core.
 *
 * `route()` ties together path parameters, validation schemas and lifecycle
 * hooks into a single config object and returns a branded `RouteDef`.
 * Controllers hold definitions as class fields; the application collects
 * them with `isRoute` — no registration, no decorators, no reflection.
 *
 * All type inference happens at the `route()` call site: the handler's
 * `ctx` is derived from the path, the schemas and the hook stacks, and hook
 * stacks are validated against the context available in their slot.
 *
 * @module
 */

import type { BodyType, ResponseMap, SchemaConfig } from "./context.ts";
import type { ValidatePath } from "./path.ts";
import type { AnySchema, InferOutput } from "./schema.ts";
import type {
  HandlerCtx,
  HooksConfig,
  HooksIndexError,
  HooksInput,
  ValidateHooks,
} from "./stack.ts";

/**
 * HTTP methods a route can handle.
 */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * OpenAPI-oriented route metadata; feeds documentation generation and has
 * no runtime behavior.
 */
export interface RouteDocs {
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;

  /**
   * Keeps the route out of the generated document.
   *
   * For endpoints that exist but are nobody's business to call: an
   * internal probe, an admin escape hatch, a route kept alive for one
   * legacy client. The route is served exactly as before — this is a
   * statement about the document, not about access, and a hidden route is
   * as reachable as any other.
   *
   * `deprecated` is the other half of the pair: an endpoint on its way out
   * stays in the document and says so, an endpoint that was never public
   * is simply absent.
   */
  readonly hidden?: boolean;

  /**
   * The operation's id in the generated document, stated rather than
   * derived.
   *
   * Without it the id is the controller's name joined with the route's
   * field — `authRequestCode` — which is stable as long as those two are.
   * State it where the id is a contract of its own: on a public API, a
   * generated SDK names its methods after these, and an id written here
   * is one a reviewer sees change.
   */
  readonly operationId?: string;
}

/**
 * The allowed handler return for a route.
 *
 * With a `response` schema the handler must return its output type (or a
 * raw `Response`); the check is structural, so runtime response validation
 * remains the barrier against leaking extra fields. Without a `response`
 * schema any return is accepted.
 *
 * A status declared `null` carries no body, which makes returning nothing
 * — the `204` a handler produces by returning `undefined` — part of the
 * contract rather than a hole in it. `void` counts as nothing too: a
 * handler that ends without a `return` is the ordinary way to write one.
 *
 * With a status map every declared shape is allowed, whatever its status:
 * `ctx.out.status = 404` followed by the 404 shape is a legitimate way to
 * answer, and the status the response leaves with decides which schema
 * checks it. Returning a documented error shape under `200` therefore
 * type-checks and then fails validation at runtime — the status is what
 * pairs a body with its contract, and only the runtime knows it.
 *
 * The other side of that rule: a status the map does not declare cannot
 * be answered with. Writing it into `ctx.out.status` is a compile error,
 * and a response that leaves with it anyway — the implicit `200` of a map
 * without one, a status a hook wrote — is refused at runtime. Declare it:
 * the map is what the documentation is generated from, and an endpoint
 * that answers `201` without saying so is missing from its own document.
 */
export type HandlerResult<S extends SchemaConfig> =
  S["response"] extends infer R extends AnySchema
    ? InferOutput<R> | Response
    : S["response"] extends infer M extends ResponseMap
      ?
          | InferOutput<Extract<M[keyof M], AnySchema>>
          | Response
          // biome-ignore lint/suspicious/noConfusingVoidType: an async handler that ends without a return produces void, which is precisely what a body-less status accepts
          | (null extends M[keyof M] ? undefined | void : never)
      : unknown;

declare const bodyTypeErrorBrand: unique symbol;

/**
 * Compile-time error: the declared body shape and the declared body schema
 * cannot both be honoured.
 */
export interface BodyTypeError<Msg extends string> {
  readonly [bodyTypeErrorBrand]: Msg;
}

/**
 * Validates the body declaration against the body schema.
 *
 * `unknown` — which an intersection ignores — for every coherent pair, and
 * a {@link BodyTypeError} for the one that is not: a `"stream"` body with
 * a `body` schema. There is nothing to validate a stream against, and the
 * two readings of such a route — buffer it after all, or ignore the schema
 * — are both worse than refusing it.
 */
export type ValidateBodyType<S extends SchemaConfig, B> = [B] extends ["stream"]
  ? S["body"] extends AnySchema
    ? BodyTypeError<"A 'stream' body cannot have a body schema: the bytes are handed to the handler unread, so there is nothing for a validator to see. Drop one of the two.">
    : unknown
  : unknown;

declare const resultErrorBrand: unique symbol;

/**
 * Compile-time error: a handler answers with something the framework will
 * not serialize.
 */
export interface ResultError<Msg extends string> {
  readonly [resultErrorBrand]: Msg;
}

/**
 * What a handler may not hand over bare: a value that produces its content
 * over time instead of holding it.
 */
type YieldsOverTime =
  | ReadableStream
  | AsyncIterable<unknown>
  | Generator<unknown, unknown, unknown>;

type IsAny<T> = 0 extends 1 & T ? true : false;

type Yielding<T> = T extends YieldsOverTime ? true : never;

/**
 * Validates what a handler returns at compile time.
 *
 * Resolves to `unknown` — which an intersection ignores — for everything
 * the framework can answer with, and to a {@link ResultError} for a value
 * that yields its content over time. `route()` intersects its `handler`
 * property with this type, so a stream returned bare fails to compile with
 * the error's message on the handler itself.
 *
 * It exists because that mistake is otherwise silent: a `ReadableStream`
 * and a generator have no own enumerable properties, so both serialize to
 * `{}` and the endpoint answers `200` with an empty body. The runtime
 * refuses them too — this is the half that never reaches a request.
 *
 * Without a `response` schema {@link HandlerResult} is `unknown` and
 * accepts anything, which is the hole this closes. A union is checked
 * member by member, because a handler that returns a stream on one branch
 * returns it. `any` is left alone: it defeats every check in the language,
 * and rejecting it here would only punish handlers that touch untyped
 * code.
 *
 * @example
 * ```ts
 * type Ok = ValidateResult<{ id: number }>;
 * //   ^? unknown
 *
 * type Bad = ValidateResult<ReadableStream>;
 * //   ^? ResultError<"A handler must not return a stream…">
 * ```
 */
export type ValidateResult<R> =
  IsAny<R> extends true
    ? unknown
    : [Yielding<Awaited<R>>] extends [never]
      ? unknown
      : ResultError<"A handler must not return a stream: it serializes to '{}' and the body is silently dropped. Wrap it in the response it belongs to — new Response(stream, { headers }) — or serve it as events with sse() from @tetsujs/sse">;

declare const unreachable: unique symbol;

/**
 * A member of {@link HandlerMustReturn} that exists to be printed.
 *
 * A bare union is anonymous, and the compiler prints it by expanding every
 * member — which is how a wrong return ends up explained as "your object
 * is missing bodyUsed, arrayBuffer, blob…", a true statement about a
 * `Response` the handler never meant to return. A union that carries this
 * member keeps its alias, so the compiler names the rule instead of
 * unfolding it.
 *
 * Nothing can satisfy it — its only property is a symbol this module never
 * exports — so it accepts nothing and loosens nothing.
 */
export interface HandlerReturnMarker {
  readonly [unreachable]: never;
}

/**
 * What `route()` accepts back from a handler: what {@link HandlerResult}
 * allows, awaited or not.
 *
 * A named type rather than the union written inline, because the name is
 * what the compiler prints when a handler returns something else — and
 * `HandlerMustReturn<Response | { id: number }>` is a sentence, where the
 * expanded union is a puzzle.
 */
export type HandlerMustReturn<Allowed> = Allowed | HandlerReturnMarker;

/**
 * The configuration accepted by `route()`.
 *
 * @typeParam Path - The route path literal; `:segments` become `ctx.params`.
 * @typeParam S - The validation schemas of the route.
 * @typeParam H - The lifecycle hooks of the route.
 * @typeParam R - What the handler returns, checked by `route()` against
 * what `response` declares.
 */
export interface RouteConfig<
  Path extends string,
  S extends SchemaConfig,
  H extends HooksInput,
  B extends BodyType | undefined,
  M extends Method,
  R = unknown,
> {
  /**
   * The method this route answers.
   *
   * Kept as a literal rather than widened to {@link Method}: the method is
   * half of a route's identity, and an application that remembers its
   * routes — for a generated client, for tooling — needs to know which one
   * this is.
   */
  readonly method: M;

  /**
   * Route path with `:param` segments, e.g. `"/orders/:id/cancel"`.
   *
   * Must start with `/`, contain no empty segments and no trailing slash;
   * a malformed literal is a compile error.
   */
  readonly path: Path & ValidatePath<Path>;

  /** Validation schemas; an absent part is neither parsed nor typed. */
  readonly schema?: S;

  /**
   * The wire shape of the request body: `"json"` (the default), `"form"`
   * or `"text"`.
   *
   * Declaring it makes the body be read even without a `body` schema — a
   * form of files alone needs no schema to be parsed. The declaration also
   * decides how the bytes are parsed: the `content-type` header is never
   * consulted, so a body that does not parse as the declared shape is a
   * `400` rather than a silent reinterpretation.
   */
  readonly bodyType?: B;

  /**
   * This route's own body ceiling, overriding the application's.
   *
   * One number cannot serve a JSON API and an upload endpoint at once:
   * raising the application's limit for the sake of one route lowers the
   * floor everywhere else, which is how a default that fits nothing gets
   * chosen. The ceiling belongs where the exception is.
   */
  readonly maxBodySize?: number;

  /** Documentation metadata for OpenAPI generation. */
  readonly docs?: RouteDocs;

  /**
   * Lifecycle hooks keyed by slot, validated against the context of their
   * slot. An object typed with an index signature is refused: none of its
   * slots could be checked (`HooksIndexError`).
   */
  readonly hooks?: H &
    (string extends keyof H ? HooksIndexError : ValidateHooks<H, Path, S, B>);

  /**
   * The endpoint logic; `ctx` is fully inferred, never annotate it.
   *
   * The return type is inferred rather than demanded, and checked twice
   * over. Against the route's own contract, by the {@link HandlerResult}
   * bound on `R`: answering with something `response` never declared is a
   * compile error that says so, instead of a structural diff against
   * `Response`. And against what the framework can serialize at all, by
   * the intersected {@link ValidateResult}: a stream handed over bare is
   * refused whether or not the route declared anything, because that is
   * the case no contract covers — without a `response` schema
   * `HandlerResult` is `unknown` and accepts every value there is.
   */
  readonly handler: (ctx: HandlerCtx<Path, S, H, B>) => R;
}

const routeBrand: unique symbol = Symbol("tetsu.route");

/**
 * A defined route: the config plus a runtime brand.
 *
 * Held as a controller class field; collected by the application via
 * `isRoute`. The `handler` keeps its inferred typing, which makes direct
 * unit testing possible — build the context with `testCtx()` from
 * `test-utils/ctx.ts` and call the handler without any HTTP.
 *
 * That includes what it returns: `R` is what `route()` inferred the
 * handler to return, so a test reads `{ id: number }` where the route's
 * contract would allow `{ id: number } | Response` and every test would
 * have to narrow first. Without an `R` — a `RouteDef` named in a
 * signature — it is everything the contract allows.
 */
export interface RouteDef<
  Path extends string = string,
  S extends SchemaConfig = SchemaConfig,
  H extends HooksInput = HooksConfig,
  B extends BodyType | undefined = BodyType | undefined,
  M extends Method = Method,
  R = HandlerResult<S> | Promise<HandlerResult<S>>,
> {
  readonly [routeBrand]: true;
  readonly method: M;
  readonly path: Path;
  readonly schema?: S;
  readonly bodyType?: B;
  readonly maxBodySize?: number;
  readonly docs?: RouteDocs;
  readonly hooks?: H;
  readonly handler: (ctx: HandlerCtx<Path, S, H, B>) => R;
}

/**
 * Defines a route.
 *
 * The handler's `ctx` is inferred from the path (`ctx.params`), the schemas
 * (`ctx.body`, `ctx.query`, `ctx.headers`) and the extensions contributed
 * by the route's hooks — it is never annotated by hand. Hook stacks are
 * validated at this call site: a hook in a wrong slot or with an unmet
 * context requirement is a compile error naming the problem.
 *
 * @example
 * ```ts
 * export const ordersController = controller("Orders", ({ orders }: OrdersDeps) => ({
 *   cancel: route({
 *     method: "POST",
 *     path: "/orders/:id/cancel",
 *     hooks: { beforeParse: [auth], beforeHandle: [withOrder] },
 *     schema: { params: OrderParams, response: Order },
 *     docs: { summary: "Cancel an order", tags: ["orders"] },
 *     handler: (ctx) => orders.cancel(ctx.order),
 *   }),
 * }));
 * ```
 */
export function route<
  const Path extends string,
  const S extends SchemaConfig = SchemaConfig,
  const H extends HooksInput = HooksConfig,
  const B extends BodyType | undefined = undefined,
  const M extends Method = Method,
  R extends HandlerMustReturn<HandlerResult<S> | Promise<HandlerResult<S>>> =
    | HandlerResult<S>
    | Promise<HandlerResult<S>>,
>(
  config: RouteConfig<Path, S, H, B, M, R> & {
    readonly handler: ValidateResult<R>;
    readonly bodyType?: ValidateBodyType<S, B>;
  },
): RouteDef<Path, S, H, B, M, R> {
  assertValidPath(config.path);

  return { ...config, [routeBrand]: true } as RouteDef<Path, S, H, B, M, R>;
}

/**
 * The runtime twin of `ValidatePath`, for a path the compiler never saw
 * as a literal: the same rules in the same order — the whole path first,
 * then one walk over the segments — so a path breaking two of them fails
 * at startup with the error the compiler would have shown.
 */
function assertValidPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`Route path must start with "/", got "${path}"`);
  }

  if (path.includes("//")) {
    throw new Error(
      `Route path must not contain empty segments ("//"), got "${path}"`,
    );
  }

  if (path.length > 1 && path.endsWith("/")) {
    throw new Error(`Route path must not end with "/", got "${path}"`);
  }

  if (path.includes("?")) {
    throw new Error(
      `Bun's router has no optional parameters, got "${path}" — ":id?" matches only a present value and names the parameter "id?"`,
    );
  }

  if (path.includes("{") || path.includes("}")) {
    throw new Error(
      `A parameter is ":id", not "{id}", got "${path}" — Bun's router matches braces as the characters they are, so the route answers only a request for that literal path`,
    );
  }

  const segments = path.split("/");

  for (const [index, segment] of segments.entries()) {
    if (segment === ":") {
      throw new Error(
        `A ":param" must have a name, got a bare ":" in "${path}" — the router matches the segment like any parameter but captures nothing`,
      );
    }

    if (segment.indexOf(":") > 0 || segment.split(":").length > 2) {
      throw new Error(
        `A ":param" must span a whole segment, got "${segment}" in "${path}" — the router captures the entire segment, so "/a/:b-:c" yields one parameter, not two`,
      );
    }

    if (
      segment.includes("*") &&
      (segment !== "*" || index !== segments.length - 1)
    ) {
      throw new Error(
        `A "*" must be the entire final segment, got "${segment}" in "${path}" — Bun's router matches "/files/*", a wildcard anywhere else never matches any request`,
      );
    }
  }
}

/**
 * Tells whether a value is a `RouteDef`.
 *
 * The application collects controller routes with
 * `Object.values(controller).filter(isRoute)` — route definitions are plain
 * enumerable class fields, nothing else is needed.
 */
export function isRoute(value: unknown): value is RouteDef {
  return typeof value === "object" && value !== null && routeBrand in value;
}
