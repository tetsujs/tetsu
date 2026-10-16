/**
 * TanStack Query options for a client: one set for React Query, Svelte
 * Query and the rest, since they share the same core.
 *
 * ```ts
 * import { queryUtils } from "@tetsujs/client/tanstack";
 *
 * const q = queryUtils(api);
 *
 * useQuery(q.get("/users/:id").queryOptions({ params: { id } }));
 * createQuery(() => q.get("/users/:id").queryOptions({ params: { id } }));
 * ```
 *
 * A query's data is the body of a success; its error a {@link ClientError}
 * of any failure the route may answer with, so `error.status === 404`
 * narrows `error.error` to the body the route declares for it. Its key is
 * the method, the path and what the call sends; {@link Endpoint.key}
 * leaves out what it is not given, to invalidate every query that shares
 * the rest.
 *
 * The options are plain objects: nothing here imports TanStack Query at
 * run time. The keys are typed with `DataTag` from `@tanstack/query-core`,
 * so `queryClient.getQueryData()` knows what a key holds.
 *
 * @module
 */

import type {
  DataTag,
  GetNextPageParamFunction,
  GetPreviousPageParamFunction,
  InfiniteData,
} from "@tanstack/query-core";
import type { Client, ClientError } from "./index.ts";
import { unwrap } from "./index.ts";
import type { Untyped } from "./routes.ts";
import type {
  CallArgs,
  CallOptions,
  ClientTypes,
  ErrorOf,
  Failure,
  Method,
  PathsOf,
  Result,
  RouteAt,
  RouteContract,
  SharedOf,
  Success,
} from "./types.ts";

/** The result of a call of route `R` by a client told `O`. */
type ResultOf<R extends RouteContract, O> = Result<R, ErrorOf<O>>;

/**
 * The data of a successful call of route `R` by a client told `O`: the
 * body of any of its successes.
 */
export type DataOf<R extends RouteContract, O = ClientTypes> = Extract<
  ResultOf<R, O>,
  Success
>["data"];

/**
 * The data of a query of route `R`: {@link DataOf}, with `null` for a
 * success without a body. TanStack Query takes `undefined` for a query
 * that returned nothing, and fails it.
 */
export type QueryDataOf<R extends RouteContract, O = ClientTypes> =
  | Exclude<DataOf<R, O>, undefined>
  | (undefined extends DataOf<R, O> ? null : never);

/**
 * The error of a query or a mutation of route `R`: a {@link ClientError}
 * for each failure the route may answer with, so its status narrows its
 * body.
 */
export type ErrorFor<R extends RouteContract, O = ClientTypes> =
  ResultOf<R, O> extends infer X
    ? X extends Failure
      ? ClientError<X>
      : never
    : never;

/** What a call of route `R` sends, and what its key holds of that. */
type Input<R extends RouteContract, O extends ClientTypes> = CallOptions<
  R,
  SharedOf<O>
>;

/**
 * The key of a query: the method, the path, and what the call sends but
 * its `init`.
 */
export type QueryKey<M extends Method, P extends string> = readonly [
  method: M,
  path: P,
  input: object,
];

/**
 * The key of an infinite query: that of a query, with a mark that keeps
 * it apart from one — the data of the two differ.
 */
export type InfiniteQueryKey<M extends Method, P extends string> = readonly [
  method: M,
  path: P,
  input: object,
  kind: { readonly infinite: true },
];

/** What {@link Endpoint.key} returns: a key, or the start of one. */
export type PartialQueryKey<M extends Method, P extends string> =
  | readonly [method: M, path: P]
  | readonly [method: M, path: P, input: object];

/** The options of a query, for `useQuery`, `createQuery`, `prefetchQuery`. */
export interface QueryOptions<D, E, K extends readonly unknown[]> {
  readonly queryKey: DataTag<K, D, E>;
  readonly queryFn: (context: { readonly signal: AbortSignal }) => Promise<D>;

  /**
   * Never set: there for the error type alone, which a query library
   * infers from it — from either, so a query that sets one of them, or a
   * suspense query, which drops `throwOnError`, keeps the type.
   */
  readonly throwOnError?: (error: E) => boolean;
  readonly retryDelay?: (failureCount: number, error: E) => number;
}

/** The options of an infinite query, for `useInfiniteQuery` and the like. */
export interface InfiniteQueryOptions<D, E, K extends readonly unknown[], P> {
  readonly queryKey: DataTag<K, InfiniteData<D, P>, E>;
  readonly queryFn: (context: {
    readonly signal: AbortSignal;
    readonly pageParam: P;
  }) => Promise<D>;
  readonly initialPageParam: P;
  readonly getNextPageParam: GetNextPageParamFunction<P, D>;
  readonly getPreviousPageParam?: GetPreviousPageParamFunction<P, D>;

  /**
   * Never set: there for the error type alone, which a query library
   * infers from it — from either, so a query that sets one of them, or a
   * suspense query, which drops `throwOnError`, keeps the type.
   */
  readonly throwOnError?: (error: E) => boolean;
  readonly retryDelay?: (failureCount: number, error: E) => number;
}

/** The options of a mutation, for `useMutation` and `createMutation`. */
export interface MutationOptions<D, E, V> {
  readonly mutationKey: readonly [method: Method, path: string];
  readonly mutationFn: (variables: V) => Promise<D>;

  /**
   * Never set: there for the error type alone, which a query library
   * infers from it — from either, so a query that sets one of them, or a
   * suspense query, which drops `throwOnError`, keeps the type.
   */
  readonly throwOnError?: (error: E) => boolean;
  readonly retryDelay?: (failureCount: number, error: E) => number;
}

/**
 * What {@link Endpoint.infiniteOptions} is given: the options of the call
 * for a page, and how to page.
 */
export interface InfiniteInput<
  R extends RouteContract,
  O extends ClientTypes,
  P,
> {
  /** The options of the call that fetches the page `pageParam`. */
  readonly input: (pageParam: P) => Input<R, O>;
  readonly initialPageParam: P;
  readonly getNextPageParam: GetNextPageParamFunction<P, QueryDataOf<R, O>>;
  readonly getPreviousPageParam?: GetPreviousPageParamFunction<
    P,
    QueryDataOf<R, O>
  >;
}

/**
 * The variables of a mutation of route `R`: the options of its call —
 * `void` when the call needs none, so `mutate()` takes nothing.
 */
export type VariablesOf<R extends RouteContract, O extends ClientTypes> =
  CallArgs<R, SharedOf<O>> extends [options: infer X]
    ? X
    : // biome-ignore lint/suspicious/noConfusingVoidType: what lets `mutate()` go without an argument
      Input<R, O> | void;

/** Part of what a call sends, each part partly, as a key may hold it. */
type Partly<X> = {
  readonly [K in Exclude<keyof X, "init">]?: X[K] extends object
    ? Partial<X[K]>
    : X[K];
};

/** What TanStack Query can do with the route at path `P` and method `M`. */
export interface Endpoint<
  R extends RouteContract,
  O extends ClientTypes,
  M extends Method,
  P extends string,
> {
  /**
   * The options of a query of the route, called with what the call would
   * be.
   *
   * @example
   * ```ts
   * const user = useQuery(q.get("/users/:id").queryOptions({ params: { id } }));
   * ```
   */
  queryOptions(
    ...options: CallArgs<R, SharedOf<O>>
  ): QueryOptions<QueryDataOf<R, O>, ErrorFor<R, O>, QueryKey<M, P>>;

  /**
   * The options of an infinite query of the route: `input` turns a page
   * param into the options of the call that fetches that page.
   *
   * @example
   * ```ts
   * useInfiniteQuery(
   *   q.get("/posts").infiniteOptions({
   *     input: (page) => ({ query: { page } }),
   *     initialPageParam: 1,
   *     getNextPageParam: (last, pages) => (last.more ? pages.length + 1 : undefined),
   *   }),
   * );
   * ```
   */
  infiniteOptions<Page>(
    options: InfiniteInput<R, O, Page>,
  ): InfiniteQueryOptions<
    QueryDataOf<R, O>,
    ErrorFor<R, O>,
    InfiniteQueryKey<M, P>,
    Page
  >;

  /**
   * The options of a mutation of the route: its variables are what the
   * call sends.
   *
   * @example
   * ```ts
   * const create = useMutation(q.post("/users").mutationOptions());
   * create.mutate({ body: { name } });
   * ```
   */
  mutationOptions(): MutationOptions<
    DataOf<R, O>,
    ErrorFor<R, O>,
    VariablesOf<R, O>
  >;

  /**
   * The key of the route's queries, or its start: the method and the path,
   * and whatever of the input it is given. Every query whose key starts
   * with it matches — an infinite one too.
   *
   * @example
   * ```ts
   * queryClient.invalidateQueries({ queryKey: q.get("/users/:id").key() });
   * ```
   */
  key(input?: Partly<Input<R, O>>): PartialQueryKey<M, P>;
}

/**
 * The endpoint of a method at a path. The contract is read off the utils
 * it is called on — `this` — as a client's call reads it: see `Call`.
 */
export type EndpointOf<M extends Method> = <
  C,
  O extends ClientTypes,
  P extends PathsOf<C, M>,
>(
  this: QueryUtils<C, O>,
  path: P,
) => Endpoint<RouteAt<C, `${M} ${P}`>, O, M, P>;

/** TanStack Query options for each route of a client. */
export interface QueryUtils<C = Untyped, O extends ClientTypes = ClientTypes> {
  readonly get: EndpointOf<"GET">;
  readonly post: EndpointOf<"POST">;
  readonly put: EndpointOf<"PUT">;
  readonly patch: EndpointOf<"PATCH">;
  readonly delete: EndpointOf<"DELETE">;

  /**
   * What the types know of the utils, for the types alone: never set.
   */
  readonly "~types"?: {
    readonly contract: C;
    readonly told: O;
  };
}

/** A call as the runtime makes it, whatever the route. */
type Send = (path: string, options?: Options) => Promise<Success | Failure>;

/** What a call sends, as the runtime reads it. */
interface Options {
  readonly init?: RequestInit;
  readonly [part: string]: unknown;
}

/**
 * TanStack Query options for the routes of a client. They call the client,
 * so one made for a request — with SvelteKit's `event.fetch`, or the
 * cookies of the request a Next server component renders — prefetches
 * on the server what the page then reads from the cache.
 *
 * @example
 * ```ts
 * const q = queryUtils(createClient<Api>({ baseUrl: "/api" }));
 *
 * const user = useQuery(q.get("/users/:id").queryOptions({ params: { id } }));
 *
 * if (user.error?.status === 404) {
 *   user.error.error; // the body the route declares for 404
 * }
 * ```
 */
export function queryUtils<C, O extends ClientTypes>(
  api: Client<C, O>,
): QueryUtils<C, O> {
  const calls = api as unknown as Readonly<Record<string, Send>>;

  const endpoint = (method: Method) => (path: string) => {
    const send = (options: Options | undefined) =>
      (calls[method.toLowerCase()] as Send).call(api, path, options);

    return {
      queryOptions: (options?: Options) => ({
        queryKey: [method, path, keyed(options)],
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          unwrap(await send(aborted(options, signal))) ?? null,
      }),

      infiniteOptions: ({
        input,
        ...paging
      }: {
        input: (pageParam: unknown) => Options;
        initialPageParam: unknown;
      }) => ({
        ...paging,
        queryKey: [
          method,
          path,
          keyed(input(paging.initialPageParam)),
          { infinite: true },
        ],
        queryFn: async ({
          signal,
          pageParam,
        }: {
          signal: AbortSignal;
          pageParam: unknown;
        }) => unwrap(await send(aborted(input(pageParam), signal))) ?? null,
      }),

      mutationOptions: () => ({
        mutationKey: [method, path],
        mutationFn: async (options?: Options) => unwrap(await send(options)),
      }),

      key: (input?: Options) =>
        input === undefined ? [method, path] : [method, path, keyed(input)],
    };
  };

  const utils = {
    get: endpoint("GET"),
    post: endpoint("POST"),
    put: endpoint("PUT"),
    patch: endpoint("PATCH"),
    delete: endpoint("DELETE"),
  };

  return utils as unknown as QueryUtils<C, O>;
}

/** What a key holds of a call: all it sends but its `init`. */
function keyed(options: Options | undefined): object {
  if (options === undefined) {
    return {};
  }

  const { init: _, ...input } = options;

  return input;
}

/**
 * The options of a call with the signal a query library aborts it by —
 * and the call's own signal, when it has one, too.
 */
function aborted(options: Options | undefined, signal: AbortSignal): Options {
  const own = options?.init?.signal;

  return {
    ...options,
    init: {
      ...options?.init,
      signal: own ? AbortSignal.any([own, signal]) : signal,
    },
  };
}
