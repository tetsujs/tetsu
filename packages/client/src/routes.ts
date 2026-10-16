/**
 * The contract of an application, read off `typeof app`: the map of routes
 * the application carries under `"~routes"`, turned into what a client
 * sends and what it receives.
 *
 * Read structurally — nothing here imports the core, so the client stays
 * free of Bun. A schema is anything with Standard Schema's `~standard`;
 * the application is anything with the map.
 *
 * @module
 */

import type {
  AnyHeaders,
  Jsonify,
  Method,
  Raw,
  RouteContract,
} from "./types.ts";

type Types<S> = S extends {
  readonly "~standard": { readonly types?: infer T };
}
  ? NonNullable<T>
  : never;

type InputOf<S> = Types<S> extends { readonly input: infer I } ? I : unknown;

type OutputOf<S> = Types<S> extends { readonly output: infer O } ? O : unknown;

/**
 * A part of the request that travels as text — the path, the query, the
 * headers, a form's fields: what the schema takes, except where it takes
 * anything. A coercing schema takes `unknown`, and what it makes of the
 * text is its output — the type a value should have to be sent.
 */
type Wire<S> = WireOf<InputOf<S>, OutputOf<S>>;

type WireOf<I, O> = unknown extends I
  ? { [K in keyof O]: Unbranded<O[K]> }
  : I extends object
    ? {
        [K in keyof I]: unknown extends I[K]
          ? K extends keyof O
            ? Unbranded<O[K]>
            : I[K]
          : I[K];
      }
    : I;

/**
 * An output as a call can send it: without the brand a schema puts on a
 * value it coerces — `z.coerce.number().brand<"UserId">()` takes a plain
 * number. A brand is the server's to make, as a generated contract leaves
 * it out.
 */
type Unbranded<T> = T extends object
  ? T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends bigint
          ? bigint
          : T extends Date
            ? Date
            : T extends readonly (infer U)[]
              ? Unbranded<U>[]
              : T
  : T;

type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * The parameters of a path without a schema: each `:name` as text or a
 * number, and the rest of a path that ends in `/*` under `"*"`.
 */
type PathParams<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? { readonly [K in Name]: string | number } & PathParams<`/${Tail}`>
    : { readonly [K in Rest]: string | number }
  : P extends `${string}/*`
    ? { readonly "*": string }
    : unknown;

/** A part of the request: optional when nothing in it is required. */
type Part<K extends string, V> =
  Record<never, never> extends V
    ? { readonly [Q in K]?: V }
    : { readonly [Q in K]: V };

type Params<P extends string, S> = S extends { readonly params: infer X }
  ? Part<"params", Flat<Omit<PathParams<P>, keyof Wire<X>> & Wire<X>>>
  : P extends `${string}:${string}` | `${string}/*`
    ? Part<"params", Flat<PathParams<P>>>
    : unknown;

type Query<S> = S extends { readonly query: infer X }
  ? Part<"query", Wire<X>>
  : unknown;

/**
 * The headers of a call: those the route's schema names, required when it
 * requires them, and any other — a hook may read one the schema does not
 * name, and a request may carry `if-none-match` or `idempotency-key`
 * whatever the route says.
 */
type Headers<S> = S extends { readonly headers: infer X }
  ? Part<"headers", Wire<X> & AnyHeaders>
  : { readonly headers?: AnyHeaders };

/** A form's value: text, a number or a date as text, or a file. */
type Field = string | number | boolean | Date | Blob;

type Body<S, B> = B extends "form"
  ? Part<
      "form",
      S extends { readonly body: infer X }
        ? Wire<X>
        : Readonly<Record<string, Field | readonly Field[]>>
    >
  : B extends "text"
    ? Part<"body", S extends { readonly body: infer X } ? InputOf<X> : string>
    : B extends "stream"
      ? Part<"body", NonNullable<RequestInit["body"]>>
      : S extends { readonly body: infer X }
        ? Part<"body", InputOf<X>>
        : B extends "json"
          ? Part<"body", unknown>
          : unknown;

/**
 * The body of one status of a response map, as the client receives it:
 * JSON as `JSON.parse` returns it, nothing for `null`, a {@link Raw} for a
 * type of its own.
 */
type Status<E> = E extends null
  ? undefined
  : E extends { readonly "~standard": unknown }
    ? Jsonify<OutputOf<E>>
    : E extends { readonly contentType: infer C extends string }
      ? Lowercase<C> extends "application/json" | `${string}+json`
        ? Entry<E>
        : Raw<C>
      : Entry<E>;

type Entry<E> = E extends { readonly body: infer X }
  ? X extends { readonly "~standard": unknown }
    ? Jsonify<OutputOf<X>>
    : undefined
  : undefined;

/**
 * The body of the failures of a class the map does not declare one by
 * one: its range — `4XX`, in either case — or else `default`.
 */
type Range<M, C extends "4" | "5"> = `${C}XX` extends keyof M
  ? { readonly [K in `${C}XX`]: Status<M[`${C}XX`]> }
  : `${C}xx` extends keyof M
    ? { readonly [K in `${C}XX`]: Status<M[`${C}xx`]> }
    : "default" extends keyof M
      ? { readonly [K in `${C}XX`]: Status<M["default"]> }
      : unknown;

type Responses<S> = S extends { readonly response: infer R }
  ? R extends { readonly "~standard": unknown }
    ? { readonly "2XX": Jsonify<OutputOf<R>> }
    : Flat<
        {
          readonly [K in keyof R as K extends number ? K : never]: Status<R[K]>;
        } & Range<R, "4"> &
          Range<R, "5">
      >
  : { readonly "2XX": unknown };

type ToRoute<E> = E extends {
  readonly path: infer P extends string;
  readonly schema: infer S;
  readonly bodyType: infer B;
}
  ? {
      readonly request: Flat<Params<P, S> & Query<S> & Headers<S> & Body<S, B>>;
      readonly responses: Responses<S>;
    }
  : never;

type FromRoutes<M> = { readonly [K in keyof M]: ToRoute<M[K]> };

/** A route of a client without a contract: anything goes, nothing is known. */
interface LooseRoute {
  readonly request: {
    readonly params?: Readonly<Record<string, unknown>>;
    readonly query?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
    readonly form?: Readonly<Record<string, unknown>>;
  };
  readonly responses: {
    readonly "2XX": unknown;
    readonly "4XX": unknown;
    readonly "5XX": unknown;
  };
}

/**
 * The contract of a client created without one: any path of any method,
 * any options, and bodies of type `unknown`.
 */
export type Untyped = {
  readonly [K in `${Method} /${string}`]: LooseRoute;
};

/**
 * The contract of `T`: the routes of an application when `T` is one —
 * `typeof app` — and `T` itself when it is a contract already.
 *
 * @example
 * ```ts
 * type Api = ContractOf<typeof app>;
 * type GetUser = Api["GET /users/:id"];
 * ```
 */
export type ContractOf<T> = T extends { readonly "~routes"?: infer M }
  ? unknown extends M
    ? T
    : FromRoutes<M>
  : T;

/**
 * What a client can be created for: an application — its map of routes
 * known, which a value without the field is not — or a contract, every
 * key of which is a route. Mapped over the keys of `T`, so that `T` can
 * be constrained by it.
 */
export type Source<T> = {
  readonly [K in keyof T]: T extends { readonly "~routes"?: infer M }
    ? unknown extends M
      ? Route<K>
      : unknown
    : Route<K>;
};

type Route<K> = K extends `${Method} /${string}` ? RouteContract : never;
