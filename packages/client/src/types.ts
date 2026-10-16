/**
 * The types of a client, read off a contract: what each route takes, and
 * what each of its responses resolves to.
 *
 * A contract is a plain object type keyed by `"METHOD /path"` — what the
 * client reads off an application through `ContractOf`, or what a
 * generated contract file declares outright. Nothing here imports the core
 * or Bun, so a contract type-checks wherever the client runs.
 *
 * @module
 */

/** The methods a route can declare, and a client can call. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The envelope the core answers a failure with: `error` is the code to
 * branch on, `message` is for people.
 */
export interface ErrorBody {
  readonly status: number;
  readonly message: string;
  readonly error: string;

  /** What failed validation, on a `422` the core answers for a request. */
  readonly issues?: readonly ValidationIssue[];
}

/** One failure of validation: what is wrong, and where in the request. */
export interface ValidationIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/** The `2xx` statuses of the IANA registry. */
export type SuccessStatus =
  | 200
  | 201
  | 202
  | 203
  | 204
  | 205
  | 206
  | 207
  | 208
  | 226;

/** The `4xx` statuses of the IANA registry. */
export type ClientErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 405
  | 406
  | 407
  | 408
  | 409
  | 410
  | 411
  | 412
  | 413
  | 414
  | 415
  | 416
  | 417
  | 418
  | 421
  | 422
  | 423
  | 424
  | 425
  | 426
  | 428
  | 429
  | 431
  | 451;

/** The `5xx` statuses of the IANA registry. */
export type ServerErrorStatus =
  | 500
  | 501
  | 502
  | 503
  | 504
  | 505
  | 506
  | 507
  | 508
  | 510
  | 511;

/**
 * Every status a failure the route does not declare may come with: the
 * `4xx` and `5xx` statuses of the IANA registry.
 *
 * A closed list rather than `number`, so that `res.status === 404` narrows
 * to the declared `404` and nothing else. A status outside the registry
 * does not compare: `(res.status as number) === 599` does.
 */
export type ErrorStatus = ClientErrorStatus | ServerErrorStatus;

/**
 * A response whose body is not JSON — a CSV, a file, an event stream. Its
 * result has no `data`: the body is read from `response`.
 */
export interface Raw<Type extends string = string> {
  readonly "~raw": Type;
}

/** A header's value as a call takes it: sent as text, a `Date` as ISO. */
export type HeaderValue = string | number | boolean | Date | undefined;

/** Headers a call may send whatever its route declares. */
export type AnyHeaders = Readonly<Record<string, HeaderValue>>;

/**
 * What a client is told beyond its contract, as the second type argument
 * of `createClient`.
 *
 * @example
 * ```ts
 * createClient<typeof app, { error: AppError; headers: "authorization" }>({
 *   headers: () => ({ authorization: `Bearer ${token}` }),
 * });
 * ```
 */
export interface ClientTypes {
  /**
   * The body of a failure no route declares, when the application answers
   * with an envelope of its own rather than the core's {@link ErrorBody}.
   */
  readonly error?: unknown;

  /**
   * The names of the headers the client sends with every request — the
   * `headers` it was created with. A route that requires one of them does
   * not require it of each call. The case does not matter: a route names
   * its headers in lower case, as the core reads them.
   */
  readonly headers?: string;
}

/**
 * What a client can be told: {@link ClientTypes}, and nothing else — so an
 * envelope, which has fields of its own, is not taken for it.
 */
export type Told<O> = {
  readonly [K in keyof O]: K extends keyof ClientTypes ? ClientTypes[K] : never;
};

/** The envelope of a client told `O`. */
export type ErrorOf<O> = O extends { readonly error: infer E } ? E : ErrorBody;

/** The headers a client told `O` sends itself. */
export type SharedOf<O> = O extends { readonly headers: infer H extends string }
  ? H
  : never;

/**
 * One route of a contract: what a call of it sends, and its responses.
 *
 * `request` is the options of a call, the parts the route declares and
 * only those: `params` — the path's `:name` segments, and the rest of a
 * path that ends in `/*` under `"*"` — `query`, `headers`, and the body,
 * as `body`, or as `form` for a route that takes a form. A part is
 * optional when nothing in it is required. `headers` takes any header
 * besides those the route names, as {@link AnyHeaders}. The path, the
 * query, the headers and
 * a form's fields travel as text — `String(value)`, a `Date` as
 * `toISOString()` — and a query array repeats its key.
 *
 * `responses` is keyed by status, the type of each body as JSON delivers
 * it — `undefined` for a status without one, a {@link Raw} for one that is
 * not JSON. Three keys say more than one status: `2XX` is the body of every
 * success, for a route with one schema for all of them; `4XX` and `5XX`
 * are the body of a failure the route does not declare, in place of the
 * client's envelope.
 *
 * Both are written out for each route rather than worked out at each
 * call: a call then reads them, and costs the compiler next to nothing.
 */
export interface RouteContract {
  readonly request: object;
  readonly responses: object;
}

/**
 * What a client accepts as its contract: every key a route. An interface
 * fits as well as a type alias — no index signature is needed.
 */
export type Contract<C> = {
  readonly [K in keyof C]: K extends `${Method} /${string}`
    ? RouteContract
    : never;
};

/** The paths of the routes of a contract that answer method `M`. */
export type PathsOf<C, M extends string> = {
  [K in keyof C]: K extends `${M} ${infer P}` ? P : never;
}[keyof C];

/**
 * The route of a contract under `key`. Read by inference rather than
 * through `keyof`: the keys of an application's map are remapped, and
 * the compiler would list them again for every call. A key that only an
 * index signature holds — the contract of a client without one — is
 * read by indexing.
 */
export type RouteAt<C, K extends PropertyKey> = C extends {
  readonly [Q in K]: infer R extends RouteContract;
}
  ? R
  : K extends keyof C
    ? C[K] extends RouteContract
      ? C[K]
      : never
    : never;

/** A response of status `S` with a `2xx` status: its body is `data`. */
export interface Success<S extends number = number, D = unknown> {
  readonly ok: true;
  readonly status: S;

  /** The body, parsed when it is JSON; `undefined` otherwise. */
  readonly data: D;

  /** The response itself — its headers, and a body that is not JSON. */
  readonly response: Response;
}

/** A response of any other status: its body is `error`. */
export interface Failure<S extends number = number, E = unknown> {
  readonly ok: false;
  readonly status: S;

  /** The body, parsed when it is JSON; `undefined` otherwise. */
  readonly error: E;

  /** The response itself — its headers, and a body that is not JSON. */
  readonly response: Response;
}

type Body<D> = D extends Raw ? undefined : D;

type Declared<X> = {
  [S in keyof X]: S extends number
    ? `${S}` extends `2${string}`
      ? Success<S, Body<X[S]>>
      : Failure<S, Body<X[S]>>
    : never;
}[keyof X];

type Ranged<X> = X extends { readonly "2XX": infer D }
  ? Success<Exclude<SuccessStatus, keyof X>, Body<D>>
  : never;

type Undeclared<X, E> =
  | Failure<
      Exclude<ClientErrorStatus, keyof X>,
      X extends { readonly "4XX": infer B } ? Body<B> : E
    >
  | Failure<
      Exclude<ServerErrorStatus, keyof X>,
      X extends { readonly "5XX": infer B } ? Body<B> : E | undefined
    >;

/**
 * What a call of route `R` resolves to: one member per status the route
 * declares, and one for every failure it does not, whose body is the
 * envelope `E` — or nothing, for a `5xx`: a proxy in front of the
 * application answers `502` and `504` with a page that is not JSON.
 *
 * Every member has its status as a literal, so `res.ok` tells success from
 * failure, and `res.status === 404` narrows to the `404` the route
 * declares.
 */
export type Result<R extends RouteContract, E = ErrorBody> =
  | Declared<R["responses"]>
  | Ranged<R["responses"]>
  | Undeclared<R["responses"], E>;

/**
 * The request of route `R` for a client that sends headers `H` itself:
 * those of them the route requires are no longer required of a call.
 */
type Sent<R extends RouteContract, H extends string> = [H] extends [never]
  ? R["request"]
  : R["request"] extends { readonly headers: infer X }
    ? Omit<R["request"], "headers"> &
        (Record<never, never> extends Shared<X, H>
          ? { readonly headers?: Shared<X, H> }
          : { readonly headers: Shared<X, H> })
    : R["request"];

type Shared<X, H extends string> = {
  readonly [K in keyof X as K extends Lowercase<H> ? never : K]: X[K];
} & {
  readonly [K in keyof X as K extends Lowercase<H> ? K : never]?: X[K];
};

/**
 * What a call of route `R` sends besides its method and path: the route's
 * `request`, and the rest of `fetch`'s options. `H` is the headers the
 * client sends itself.
 */
export type CallOptions<
  R extends RouteContract,
  H extends string = never,
> = Sent<R, H> & {
  /** The rest of `fetch`'s options — `signal`, `credentials`, `cache`. */
  readonly init?: Omit<RequestInit, "method" | "headers" | "body">;
};

/**
 * The options argument of a call of route `R`: required when a part is,
 * left out otherwise.
 */
export type CallArgs<R extends RouteContract, H extends string = never> =
  Record<never, never> extends Sent<R, H>
    ? [options?: CallOptions<R, H>]
    : [options: CallOptions<R, H>];

type UrlOptions<R> = R extends RouteContract
  ? Pick<R["request"], Extract<keyof R["request"], "params" | "query">> & {
      readonly [K in Exclude<"params" | "query", keyof R["request"]>]?: never;
    }
  : never;

/**
 * The options argument of `url()` for a path: the parameters and the query
 * of a route at it — of any of them, when several methods share the path.
 */
export type UrlArgs<R extends RouteContract> =
  Record<never, never> extends UrlOptions<R>
    ? [options?: UrlOptions<R>]
    : [options: UrlOptions<R>];

/** The routes of a contract at `path`, whatever their method. */
export type RoutesAt<C, P extends string> = {
  [M in Method]: RouteAt<C, `${M} ${P}`>;
}[Method];

/**
 * What `JSON.stringify` and `JSON.parse` make of a value of type `T`: a
 * `Date` — anything with `toJSON` — becomes what that returns, a `Map` or
 * a `Set` an empty object, a property that may be `undefined` an optional
 * one, an `undefined` in an array `null`; functions and symbols are gone.
 */
export type Jsonify<T> = unknown extends T
  ? T
  : T extends string | number | boolean | null
    ? T
    : T extends { toJSON(): infer J }
      ? Jsonify<J>
      : T extends undefined | symbol | bigint | ((...args: never) => unknown)
        ? never
        : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
          ? Record<never, never>
          : T extends readonly unknown[]
            ? { -readonly [K in keyof T]: Item<T[K]> }
            : T extends object
              ? JsonObject<T>
              : never;

type Item<T> = undefined extends T ? Jsonify<T> | null : Jsonify<T>;

type JsonObject<T> = Flat<
  {
    -readonly [K in keyof T as Kept<K, T[K]> extends true
      ? undefined extends T[K]
        ? K
        : never
      : never]?: Jsonify<T[K]>;
  } & {
    -readonly [K in keyof T as Kept<K, T[K]> extends true
      ? undefined extends T[K]
        ? never
        : K
      : never]: Jsonify<T[K]>;
  }
>;

/** Whether `JSON.stringify` writes a property: not a symbol's, nor a function or a symbol. */
type Kept<K, V> = K extends symbol
  ? false
  : [V] extends [symbol | ((...args: never) => unknown)]
    ? false
    : true;

type Flat<T> = { [K in keyof T]: T[K] } & {};
