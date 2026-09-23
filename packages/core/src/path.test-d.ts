/**
 * Type-level tests for route path parameter extraction.
 *
 * @module
 */

import type { Equal, Expect } from "../test-utils/types.ts";
import type { ExtractParams, PathError, ValidatePath } from "./path.ts";

export type validatePathCases = [
  Expect<Equal<ValidatePath<"/orders/:id">, "/orders/:id">>,
  Expect<Equal<ValidatePath<"/">, "/">>,
  Expect<
    Equal<ValidatePath<"orders">, PathError<"Route path must start with '/'">>
  >,
  Expect<
    Equal<
      ValidatePath<"/a//b">,
      PathError<"Route path must not contain empty segments ('//')">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/orders/">,
      PathError<"Route path must not end with '/'">
    >
  >,
  Expect<Equal<ValidatePath<"/files/*">, "/files/*">>,
  Expect<
    Equal<
      ValidatePath<"/a/*/b">,
      PathError<"A '*' must be the entire final segment: Bun's router matches '/files/*', but a wildcard anywhere else never matches any request">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/files/*rest">,
      PathError<"A '*' must be the entire final segment: Bun's router matches '/files/*', but a wildcard anywhere else never matches any request">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/opt/:id?">,
      PathError<"Bun's router has no optional parameters: ':id?' matches only a present value and names the parameter 'id?'">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/users/{id}">,
      PathError<"A parameter is ':id', not '{id}': Bun's router matches braces as the characters they are, so '/users/{id}' answers only a request for that literal path">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/a/}">,
      PathError<"A parameter is ':id', not '{id}': Bun's router matches braces as the characters they are, so '/users/{id}' answers only a request for that literal path">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/a/:">,
      PathError<"A ':param' must have a name: a bare ':' matches a segment like any parameter but captures nothing, leaving a parameter named ''">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/:">,
      PathError<"A ':param' must have a name: a bare ':' matches a segment like any parameter but captures nothing, leaving a parameter named ''">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/a/:/b">,
      PathError<"A ':param' must have a name: a bare ':' matches a segment like any parameter but captures nothing, leaving a parameter named ''">
    >
  >,
  Expect<Equal<ValidatePath<"/a/:id">, "/a/:id">>,
  Expect<Equal<ValidatePath<"/a/:id/b/:name">, "/a/:id/b/:name">>,
];

type Malformed =
  PathError<"A ':param' must span a whole segment: '/a/:b-:c' captures one parameter holding the entire segment, and '/a/b:c' declares a parameter named 'c'">;

/**
 * A path holding none of the characters a rule is about skips the rules
 * altogether, and one that does holds them in a single walk; these pin
 * both branches of a segment's `:` rule and a parameter meeting a final
 * wildcard, which only the walk sees.
 */
export type segmentWalkCases = [
  Expect<Equal<ValidatePath<"/a/:b-:c">, Malformed>>,
  Expect<Equal<ValidatePath<"/a/b:c">, Malformed>>,
  Expect<Equal<ValidatePath<"/a/b:c/:id">, Malformed>>,
  Expect<Equal<ValidatePath<"/a/:id/*">, "/a/:id/*">>,
  Expect<Equal<ValidatePath<"/plain/segments/only">, "/plain/segments/only">>,
];

/**
 * A path that breaks two rules gets the error of the one checked first.
 * `assertValidPath` checks in the same order, and `route.test.ts` pins the
 * same paths, so what the compiler shows is what startup throws.
 */
export type ruleOrderCases = [
  Expect<
    Equal<
      ValidatePath<"/a*/b:c">,
      PathError<"A '*' must be the entire final segment: Bun's router matches '/files/*', but a wildcard anywhere else never matches any request">
    >
  >,
  Expect<Equal<ValidatePath<"/a:b/c*">, Malformed>>,
  Expect<
    Equal<
      ValidatePath<"/:/a:b">,
      PathError<"A ':param' must have a name: a bare ':' matches a segment like any parameter but captures nothing, leaving a parameter named ''">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/a*/:id?">,
      PathError<"Bun's router has no optional parameters: ':id?' matches only a present value and names the parameter 'id?'">
    >
  >,
  Expect<
    Equal<
      ValidatePath<"/a*/{id}">,
      PathError<"A parameter is ':id', not '{id}': Bun's router matches braces as the characters they are, so '/users/{id}' answers only a request for that literal path">
    >
  >,
];

export type cases = [
  Expect<Equal<keyof ExtractParams<"/health">, never>>,
  Expect<Equal<keyof ExtractParams<"/">, never>>,
  Expect<Equal<ExtractParams<"/users/:id">, { id: string }>>,
  Expect<Equal<ExtractParams<"/:id">, { id: string }>>,
  Expect<Equal<ExtractParams<"/users/:id/edit">, { id: string }>>,
  Expect<
    Equal<
      ExtractParams<"/orders/:orderId/items/:itemId">,
      { orderId: string; itemId: string }
    >
  >,
];
