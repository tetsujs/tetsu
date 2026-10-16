/**
 * A fetch client for a Tetsu application: one function per method, called
 * with the path as the route declares it.
 *
 * ```ts
 * import type { app } from "../server/src/app";
 *
 * const api = createClient<typeof app>({ baseUrl: "https://api.example.com" });
 *
 * const res = await api.get("/users/:id", { params: { id: 42 } });
 *
 * if (res.ok) {
 *   res.data.name;
 * } else if (res.status === 404) {
 *   res.error.error;
 * }
 * ```
 *
 * The types come from the application — `typeof app`, imported as a type —
 * or from a contract that declares the same routes without the server's
 * code. Paths are suggested by method; a call takes what its route
 * declares and nothing else; its result has one member per status, each
 * body as JSON delivers it.
 *
 * A declared status is a result, not an exception: `ok` tells success from
 * failure, and `status` which response it was. Only what is not a response
 * throws — the network failing, the request aborted, a JSON body that does
 * not parse. {@link unwrap} turns a failure into a {@link ClientError} for
 * code that expects one thrown.
 *
 * Nothing here reaches for Bun or the core: the client runs in a browser,
 * Node, Deno or Bun, on whatever `fetch` it is given.
 *
 * @module
 */

import type { ContractOf, Source, Untyped } from "./routes.ts";
import type {
  CallArgs,
  ClientTypes,
  ErrorOf,
  Failure,
  Method,
  PathsOf,
  Result,
  RouteAt,
  RoutesAt,
  SharedOf,
  Success,
  Told,
  UrlArgs,
} from "./types.ts";

export type { ContractOf, Source, Untyped } from "./routes.ts";
export type {
  AnyHeaders,
  CallArgs,
  CallOptions,
  ClientErrorStatus,
  ClientTypes,
  Contract,
  ErrorBody,
  ErrorOf,
  ErrorStatus,
  Failure,
  HeaderValue,
  Jsonify,
  Method,
  PathsOf,
  Raw,
  Result,
  RouteAt,
  RouteContract,
  RoutesAt,
  ServerErrorStatus,
  SharedOf,
  Success,
  SuccessStatus,
  Told,
  UrlArgs,
  ValidationIssue,
} from "./types.ts";

/**
 * The request the client hands to `fetch`: `RequestInit` with the headers
 * as a plain record.
 *
 * A record rather than a `Headers` object, so a function that reads headers
 * as a record — the test client of `@tetsujs/core/testing` — gets them all.
 * `fetch` takes either.
 */
export interface FetchInit extends Omit<RequestInit, "headers"> {
  readonly headers: Record<string, string>;
}

/**
 * The `fetch` a client sends with. The global one by default; SvelteKit's
 * `event.fetch`, a test client with a cookie jar, or a wrapper that retries
 * or logs fit too.
 */
export type Fetch = (url: string, init: FetchInit) => Promise<Response>;

/** Headers as `fetch` takes them. */
export type HeadersInput = ConstructorParameters<typeof Headers>[0];

/** How a client reaches the application. */
export interface ClientOptions {
  /**
   * Where the application is, put before every path —
   * `https://api.example.com` or `https://example.com/api`. A trailing
   * slash is dropped. Empty by default: the paths stay relative, for a
   * `fetch` that resolves them itself.
   */
  readonly baseUrl?: string | URL;

  /**
   * Headers sent with every request, or a function that returns them —
   * asked again for each request, so a token read from a store is always
   * the current one. A header a call sets wins over these.
   */
  readonly headers?:
    | HeadersInput
    | (() => HeadersInput | Promise<HeadersInput>);

  /** The `fetch` to send with. The global `fetch` by default. */
  readonly fetch?: Fetch;
}

/** What a call sends, as the runtime reads it whatever the route. */
interface Options {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly form?: Readonly<Record<string, unknown>>;
  readonly init?: Omit<RequestInit, "method" | "headers" | "body">;
}

/**
 * A call of one method: the path of a route that answers it, as the route
 * declares it, then what that route takes.
 *
 * The contract is read off the client the method is called on — `this` —
 * rather than kept in the method's own type. Kept there, the compiler
 * would walk the whole contract again for every call: an application of
 * 1 600 routes stopped compiling. A method taken off its client —
 * `const { get } = api` — therefore has no contract to read; call it on
 * the client.
 */
export type Call<M extends Method> = <
  C,
  O extends ClientTypes,
  P extends PathsOf<C, M>,
>(
  this: Client<C, O>,
  path: P,
  ...options: CallArgs<RouteAt<C, `${M} ${P}`>, SharedOf<O>>
) => Promise<Result<RouteAt<C, `${M} ${P}`>, ErrorOf<O>>>;

/**
 * A client: a call per method, and the address of a path without a
 * request.
 *
 * `C` is the contract, `O` what the client was told besides — see
 * {@link ClientTypes}.
 */
export interface Client<C = Untyped, O extends ClientTypes = ClientTypes> {
  readonly get: Call<"GET">;
  readonly post: Call<"POST">;
  readonly put: Call<"PUT">;
  readonly patch: Call<"PATCH">;
  readonly delete: Call<"DELETE">;

  /**
   * The address a call to `path` would request, for what makes the request
   * itself — an `<img src>`, a link, an `EventSource`.
   *
   * @example
   * ```ts
   * new EventSource(api.url("/events/:room", { params: { room } }));
   * ```
   */
  url<C, O extends ClientTypes, P extends PathsOf<C, Method>>(
    this: Client<C, O>,
    path: P,
    ...options: UrlArgs<RoutesAt<C, P>>
  ): string;

  /**
   * What the types know of the client, for the types alone: never set.
   */
  readonly "~types"?: {
    readonly contract: C;
    readonly told: O;
  };
}

/**
 * Creates a client. It is a plain object of functions, cheap enough to
 * create one per request — with SvelteKit's `event.fetch` in a `load`, or
 * with the cookies of the request a Next server component renders.
 *
 * `T` is what the types come from: the application — `typeof app` — or a
 * contract. Without it every path and option is accepted and every body
 * is `unknown`. `O` tells the client the rest, see {@link ClientTypes}:
 * the envelope of a failure no route declares, when the application
 * answers with its own, and the headers it sends itself, which a route
 * that requires them then does not require of each call.
 *
 * On TypeScript 5.7 every call of a client read off `typeof app` walks
 * the application's routes again; later versions do not. A contract
 * declared as an interface spares 5.7 too:
 * `interface Api extends ContractOf<typeof app> {}`, then
 * `createClient<Api>()`.
 *
 * @example
 * ```ts
 * import type { app } from "../server/src/app";
 *
 * const api = createClient<typeof app>({
 *   baseUrl: "https://api.example.com",
 *   headers: () => ({ authorization: `Bearer ${session.token}` }),
 * });
 * ```
 */
export function createClient<
  T extends Source<T> = Untyped,
  O extends ClientTypes & Told<O> = ClientTypes,
>(options: ClientOptions = {}): Client<ContractOf<T>, O> {
  let base = String(options.baseUrl ?? "");

  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }

  const call =
    (method: string) =>
    async (path: string, call: Options = {}): Promise<Success | Failure> => {
      const shared =
        typeof options.headers === "function"
          ? await options.headers()
          : options.headers;

      const { body, contentType, typed } = encode(call);
      const headers = new Headers();

      if (contentType !== undefined) {
        headers.set("content-type", contentType);
      }

      for (const [name, value] of new Headers(shared)) {
        if (!(typed && name === "content-type")) {
          headers.set(name, value);
        }
      }

      for (const [name, value] of Object.entries(call.headers ?? {})) {
        if (value !== undefined) {
          headers.set(name, text(value));
        }
      }

      const send = options.fetch ?? fetch;
      const response = await send(address(base, path, call), {
        ...call.init,
        method,
        headers: Object.fromEntries(headers),
        ...(body === undefined ? {} : { body }),
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      });

      const payload = await read(response);

      return response.ok
        ? { ok: true, status: response.status, data: payload, response }
        : { ok: false, status: response.status, error: payload, response };
    };

  const client = {
    get: call("GET"),
    post: call("POST"),
    put: call("PUT"),
    patch: call("PATCH"),
    delete: call("DELETE"),
    url: (path: string, call: Options = {}) => address(base, path, call),
  };

  return client as unknown as Client<ContractOf<T>, O>;
}

/**
 * Thrown by {@link unwrap} for a response that is not `2xx`. It carries
 * what the result did: the status, the parsed body — the result's
 * `error`, here `body`, so that `error.body.error` reads as the code of
 * the body of the error — and the response.
 *
 * `F` is the failure it was made of. Caught, it is a `ClientError` of
 * any failure — the compiler does not know what a `try` block throws —
 * and `body` is whatever the body was; a typed one reaches only code
 * that is given the type, as a query library is.
 */
export class ClientError<F extends Failure = Failure> extends Error {
  readonly status: F["status"];
  readonly body: F["error"];
  readonly response: Response;

  constructor(failure: F) {
    super(`The server answered ${failure.status}`);

    this.name = "ClientError";
    this.status = failure.status;
    this.body = failure.error;
    this.response = failure.response;
  }
}

/**
 * The data of a successful result, or a {@link ClientError} thrown for any
 * other — for code that expects a failure thrown, as TanStack Query does.
 *
 * @example
 * ```ts
 * const user = unwrap(await api.get("/users/:id", { params: { id } }));
 * ```
 */
export function unwrap<R extends Success | Failure>(
  result: R,
): Extract<R, { readonly ok: true }>["data"] {
  if (result.ok) {
    return result.data;
  }

  throw new ClientError(result);
}

/** A value of a path, query or header as text. */
function text(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The address of a call: the base, the path with its parameters filled in,
 * and the query.
 *
 * A parameter's name runs to the next `/`, as the core reads it, and its
 * value is encoded as one segment — a `/` in it does not split the path.
 * The wildcard of a path ending in `/*` takes its value from `params["*"]`
 * and is a path: each segment is encoded, the slashes between them kept.
 *
 * A parameter without a value throws rather than send `undefined` to a
 * route that would answer `404` for it. So does a segment of `.` or `..`,
 * or an empty one: `fetch` resolves those however they are encoded, and
 * `/users/../sessions` reaches `/sessions` — another route.
 */
function address(
  base: string,
  path: string,
  call: Pick<Options, "params" | "query">,
): string {
  const filled = path.replace(
    /:([^/]+)|(?<=\/)\*$/g,
    (match, name: string | undefined) => {
      const key = name ?? match;
      const value = call.params?.[key];

      if (value === undefined) {
        throw new TypeError(`No value for the parameter "${key}" of ${path}`);
      }

      const segments =
        name === undefined ? text(value).split("/") : [text(value)];

      return segments
        .map((segment) => encodeSegment(segment, key, path))
        .join("/");
    },
  );

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(call.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) {
        search.append(key, text(item));
      }
    }
  }

  const query = search.size === 0 ? "" : `?${search}`;

  return `${base}${filled}${query}`;
}

/** A segment of a path, encoded — unless it would move the request elsewhere. */
function encodeSegment(segment: string, key: string, path: string): string {
  if (segment === "" || segment === "." || segment === "..") {
    throw new TypeError(
      `"${segment}" cannot be the parameter "${key}" of ${path}: the request would go to another path`,
    );
  }

  return encodeURIComponent(segment);
}

/**
 * The body of a call as `fetch` sends it, and its type when that is the
 * client's to set.
 *
 * `typed` is a body whose type `fetch` takes from the body itself — a form
 * with its boundary, `URLSearchParams`, a `Blob` that has a type — which a
 * `content-type` among the client's headers would only break. A call's own
 * header still wins: that one was meant for this body.
 */
function encode(call: Options): {
  readonly body?: RequestInit["body"];
  readonly contentType?: string;
  readonly typed?: boolean;
} {
  if (call.form !== undefined) {
    const form = new FormData();

    for (const [key, value] of Object.entries(call.form)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined) {
          continue;
        }

        if (item instanceof Blob) {
          form.append(key, item);
        } else {
          form.append(key, text(item));
        }
      }
    }

    return { body: form, typed: true };
  }

  const { body } = call;

  if (body === undefined) {
    return {};
  }

  if (
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    (body instanceof Blob && body.type !== "")
  ) {
    return { body, typed: true };
  }

  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof ReadableStream
  ) {
    return { body: body as RequestInit["body"] };
  }

  return { body: JSON.stringify(body), contentType: "application/json" };
}

/**
 * The body of a response, parsed when its type is JSON — `application/json`
 * or a `+json` type such as `application/problem+json`. Any other body is
 * left unread on the response; an empty one is `undefined`.
 */
async function read(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";")[0];
  const media = type?.trim().toLowerCase() ?? "";

  if (media !== "application/json" && !media.endsWith("+json")) {
    return undefined;
  }

  const body = await response.text();

  return body === "" ? undefined : JSON.parse(body);
}
