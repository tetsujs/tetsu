/**
 * A fetch client for a Tetsu application: one function per method, called
 * with the path as the route declares it.
 *
 * ```ts
 * const api = createClient({ baseUrl: "https://api.example.com" });
 *
 * const res = await api.get("/users/:id", { params: { id: 42 } });
 *
 * if (res.ok) {
 *   res.data;
 * } else if (res.status === 404) {
 *   res.error;
 * }
 * ```
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

/**
 * What a call sends besides its method and path.
 *
 * Path parameters, the query and headers travel as text: a value is sent
 * as `String(value)`, a `Date` as `toISOString()`. A query value that is an
 * array repeats the key, which the core reads back as the array; one that
 * is `undefined` is left out.
 */
export interface CallOptions {
  /** The values of the path's `:name` segments, each encoded as one segment. */
  readonly params?: Readonly<Record<string, unknown>>;

  readonly query?: Readonly<Record<string, unknown>>;

  /** Headers of this request; they win over the client's. */
  readonly headers?: Readonly<Record<string, unknown>>;

  /**
   * The body. A string, `Blob`, `ArrayBuffer`, typed array, `FormData`,
   * `URLSearchParams` or `ReadableStream` is sent as it is; anything else
   * as JSON, with `content-type: application/json`.
   */
  readonly body?: unknown;

  /**
   * A form body, as an object: sent as `FormData`, a `Blob` or `File` as a
   * file and every other value as text, an array as the field repeated.
   */
  readonly form?: Readonly<Record<string, unknown>>;

  /** The rest of `fetch`'s options — `signal`, `credentials`, `cache`. */
  readonly init?: Omit<RequestInit, "method" | "headers" | "body">;
}

/** A `2xx` response: its parsed body is `data`. */
export interface Success {
  readonly ok: true;
  readonly status: number;

  /** The body, parsed when it is JSON; `undefined` otherwise. */
  // biome-ignore lint/suspicious/noExplicitAny: untyped until the client reads the application's routes.
  readonly data: any;

  /** The response itself — its headers, and a body that is not JSON. */
  readonly response: Response;
}

/** Any other response: its parsed body is `error`. */
export interface Failure {
  readonly ok: false;
  readonly status: number;

  /** The body, parsed when it is JSON; `undefined` otherwise. */
  // biome-ignore lint/suspicious/noExplicitAny: untyped until the client reads the application's routes.
  readonly error: any;

  /** The response itself — its headers, and a body that is not JSON. */
  readonly response: Response;
}

/** What a call resolves to: one response, read. */
export type Result = Success | Failure;

/** A call of one method: the route's path, then what to send. */
export type Call = (path: string, options?: CallOptions) => Promise<Result>;

/** A client: a call per method, and the address of a path without a request. */
export interface Client {
  readonly get: Call;
  readonly post: Call;
  readonly put: Call;
  readonly patch: Call;
  readonly delete: Call;

  /**
   * The address a call to `path` would request, for what makes the request
   * itself — an `<img src>`, a link, an `EventSource`.
   *
   * @example
   * ```ts
   * new EventSource(api.url("/events/:room", { params: { room } }));
   * ```
   */
  url(path: string, options?: Pick<CallOptions, "params" | "query">): string;
}

/**
 * Creates a client. It is a plain object of functions, cheap enough to
 * create one per request — with SvelteKit's `event.fetch` in a `load`, or
 * with the cookies of the request a Next server component renders.
 *
 * @example
 * ```ts
 * const api = createClient({
 *   baseUrl: "https://api.example.com",
 *   headers: () => ({ authorization: `Bearer ${session.token}` }),
 * });
 * ```
 */
export function createClient(options: ClientOptions = {}): Client {
  const base = String(options.baseUrl ?? "").replace(/\/+$/, "");

  const call =
    (method: string): Call =>
    async (path, call = {}) => {
      const shared =
        typeof options.headers === "function"
          ? await options.headers()
          : options.headers;

      const { body, contentType } = encode(call);
      const headers = new Headers();

      if (contentType !== undefined) {
        headers.set("content-type", contentType);
      }

      for (const [name, value] of new Headers(shared)) {
        headers.set(name, value);
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

  return {
    get: call("GET"),
    post: call("POST"),
    put: call("PUT"),
    patch: call("PATCH"),
    delete: call("DELETE"),
    url: (path, call = {}) => address(base, path, call),
  };
}

/**
 * Thrown by {@link unwrap} for a response that is not `2xx`. It carries
 * what the result did: the status, the parsed body as `error`, and the
 * response.
 */
export class ClientError extends Error {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: untyped until the client reads the application's routes.
  readonly error: any;
  readonly response: Response;

  constructor(failure: Failure) {
    super(`The server answered ${failure.status}`);

    this.name = "ClientError";
    this.status = failure.status;
    this.error = failure.error;
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
// biome-ignore lint/suspicious/noExplicitAny: untyped until the client reads the application's routes.
export function unwrap(result: Result): any {
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
 * A parameter without a value throws rather than send `undefined` to a
 * route that would answer `404` for it.
 */
function address(
  base: string,
  path: string,
  call: Pick<CallOptions, "params" | "query">,
): string {
  const filled = path.replace(/:([^/]+)/g, (_, name: string) => {
    const value = call.params?.[name];

    if (value === undefined) {
      throw new TypeError(`No value for the parameter "${name}" of ${path}`);
    }

    return encodeURIComponent(text(value));
  });

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

/** The body of a call as `fetch` sends it, and its type when that is the client's to set. */
function encode(call: CallOptions): {
  readonly body?: RequestInit["body"];
  readonly contentType?: string;
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

    return { body: form };
  }

  const { body } = call;

  if (body === undefined) {
    return {};
  }

  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
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
