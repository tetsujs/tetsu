/**
 * Type-level analysis of route path strings.
 *
 * @module
 */

import type { Prettify } from "./internal.ts";

type ExtractParamsRec<Path extends string> =
  Path extends `${string}:${infer Rest}`
    ? Rest extends `${infer Param}/${infer Tail}`
      ? { [K in Param]: string } & ExtractParamsRec<`/${Tail}`>
      : { [K in Rest]: string }
    : unknown;

/**
 * Extracts named `:param` segments of a route path as an object type.
 *
 * Every parameter is `string` at this level — raw values taken from the URL.
 * A route can narrow them further (e.g. to `number`) with `schema.params`.
 * Paths without parameters produce an empty object type.
 *
 * @example
 * ```ts
 * type OrderItem = ExtractParams<"/orders/:orderId/items/:itemId">;
 * //   ^? { orderId: string; itemId: string }
 *
 * type Health = ExtractParams<"/health">;
 * //   ^? {}
 * ```
 */
export type ExtractParams<Path extends string> = Prettify<
  ExtractParamsRec<Path>
>;

declare const pathErrorBrand: unique symbol;

/**
 * Compile-time error: a route path or group prefix is malformed.
 */
export interface PathError<Msg extends string> {
  readonly [pathErrorBrand]: Msg;
}

/**
 * Validates a path literal at compile time.
 *
 * Resolves to the path itself when valid, and to a `PathError` otherwise —
 * `route()` intersects its `path` property with this type, so a malformed
 * path fails to compile with the error's message. The rules: a path starts
 * with `/`, has no empty segments (`//`) and no trailing slash; the bare
 * `"/"` is a valid root path.
 *
 * @example
 * ```ts
 * type Ok = ValidatePath<"/orders/:id">;
 * //   ^? "/orders/:id"
 *
 * type Bad = ValidatePath<"orders">;
 * //   ^? PathError<"Route path must start with '/'">
 * ```
 */
export type ValidatePath<P extends string> = P extends `/${infer Body}`
  ? P extends `${string}${":" | "*" | "?" | "{" | "}" | "//"}${string}`
    ? SlowValidatePath<P, Body>
    : P extends `${string}/`
      ? P extends "/"
        ? P
        : PathError<"Route path must not end with '/'">
      : P
  : PathError<"Route path must start with '/'">;

/**
 * The rules for a path that contains something worth checking.
 *
 * `ValidatePath` sends here only a path holding one of the characters a
 * rule is about, so a plain `/health` or `/users/list` costs two template
 * matches instead of every rule. It matters because every route pays it:
 * running each segment rule as its own walk was a fifth of what a bare
 * route cost the compiler (`bench/src/types.ts`).
 *
 * `{` or `}` anywhere in a path is rejected for the same reason as `?` and
 * a bare `:`: it is syntax that reads as a parameter and is not one. `{id}`
 * is how OpenAPI, Spring and FastAPI spell a parameter, so it is the first
 * thing someone arriving from them writes — and Bun matches it literally,
 * leaving a route that answers nothing while looking correct. A literal
 * brace in a URL is percent-encoded in practice, so nothing legitimate is
 * lost.
 */
type SlowValidatePath<
  P extends string,
  Body extends string,
> = P extends `${string}//${string}`
  ? PathError<"Route path must not contain empty segments ('//')">
  : P extends `${string}/`
    ? PathError<"Route path must not end with '/'">
    : P extends `${string}?${string}`
      ? PathError<"Bun's router has no optional parameters: ':id?' matches only a present value and names the parameter 'id?'">
      : P extends `${string}${"{" | "}"}${string}`
        ? PathError<"A parameter is ':id', not '{id}': Bun's router matches braces as the characters they are, so '/users/{id}' answers only a request for that literal path">
        : [SegmentError<Body>] extends [never]
          ? P
          : PathError<SegmentError<Body>>;

/**
 * The first segment rule a path breaks, or `never`: one walk over the
 * segments applies all of them.
 */
type SegmentError<Body extends string> =
  Body extends `${infer Segment}/${infer Rest}`
    ? [SegmentProblem<Segment, false>] extends [never]
      ? SegmentError<Rest>
      : SegmentProblem<Segment, false>
    : SegmentProblem<Body, true>;

/**
 * What is wrong with one segment, or `never`.
 *
 * A bare `:` is a parameter with no name. Bun matches such a segment like
 * any other parameter, but captures nothing — verified against the live
 * router — while `ExtractParams` promises a parameter named `''`.
 *
 * A segment is malformed when a `:` appears anywhere but at its start, or
 * twice.
 */
type SegmentProblem<S extends string, Last extends boolean> = S extends ":"
  ? "A ':param' must have a name: a bare ':' matches a segment like any parameter but captures nothing, leaving a parameter named ''"
  : S extends `:${infer Name}`
    ? Name extends `${string}:${string}`
      ? MalformedMessage
      : StarProblem<S, Last>
    : S extends `${string}:${string}`
      ? MalformedMessage
      : StarProblem<S, Last>;

type MalformedMessage =
  "A ':param' must span a whole segment: '/a/:b-:c' captures one parameter holding the entire segment, and '/a/b:c' declares a parameter named 'c'";

/**
 * `*` is legal only as the entire final segment — that is the one form
 * Bun's router matches. A `*` in the middle (`/a/*\/b`) produces a route
 * that never matches anything, and a decorated one (`/files/*rest`)
 * matches like a bare `*` but captures nothing — both verified against
 * the live router.
 */
type StarProblem<
  S extends string,
  Last extends boolean,
> = S extends `${string}*${string}`
  ? [Last, S] extends [true, "*"]
    ? never
    : "A '*' must be the entire final segment: Bun's router matches '/files/*', but a wildcard anywhere else never matches any request"
  : never;

/**
 * Validates a group prefix at compile time.
 *
 * Stricter than {@link ValidatePath}: a prefix must mount something (`"/"`
 * alone is a no-op) and may not declare `:params`. A prefix parameter would
 * exist at runtime but never in `ctx.params` — a controller is typed where
 * it is written, not where it is mounted — and a route's own `params` schema
 * would then strip it. Rejecting it turns a silent surprise into a startup
 * error; the restriction can be lifted later without breaking anything.
 *
 * @example
 * ```ts
 * type Ok = ValidatePrefix<"/api/v1">;
 * //   ^? "/api/v1"
 *
 * type Bad = ValidatePrefix<"/tenants/:id">;
 * //   ^? PathError<"Group prefix must not declare ':params'">
 * ```
 */
export type ValidatePrefix<P extends string> = P extends "/"
  ? PathError<"Group prefix '/' is a no-op — mount the children directly">
  : P extends `${string}:${string}`
    ? PathError<"Group prefix must not declare ':params'">
    : P extends `${string}*${string}`
      ? PathError<"Group prefix must not contain '*' — a wildcard inside a joined path never matches in Bun's router">
      : ValidatePath<P> extends PathError<infer Msg>
        ? PathError<Msg>
        : P;
