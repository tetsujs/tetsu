/**
 * Test helper: a client that keeps its own headers and cookies.
 *
 * A test of a session reads like a browser's afternoon — sign in, look
 * around, sign out — and the plain request function makes it carry the
 * session by hand: parse `set-cookie`, paste `cookie` into every request.
 * The client does what a browser does instead, for one server and one test.
 *
 * @module
 */

/**
 * The cookies a client holds.
 *
 * Values read the way the application reads them from `ctx.cookies`, and
 * are written the way `ctx.out.cookies.set` writes them. A signed cookie
 * is opaque here: the client has no secret, so it holds and returns the
 * value with its signature, as a browser would.
 */
export interface CookieJar {
  /**
   * The value held under this name, or `undefined`.
   *
   * With the name set under several paths, the value of the longest path
   * — the one a request under all of them sends first.
   */
  get(name: string): string | undefined;

  /**
   * Holds a cookie as if a response had set it — to plant a forged or
   * stale value, say. `path` is `/` unless given.
   */
  set(
    name: string,
    value: string,
    attributes?: { readonly path?: string },
  ): void;

  /** Forgets the name, under every path. */
  delete(name: string): void;
}

/** What every request of a client carries. */
export interface ClientOptions {
  /**
   * Headers sent with every request, unless one names the same header —
   * say, the address a rate limiter keys on, fresh for each test.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A request as the client takes it: `fetch`'s own options, with headers as
 * a record and a JSON body as a value.
 *
 * A header set to `null` is not sent at all, even if the client's defaults
 * or its cookies would send it — `{ cookie: null }` is a request without a
 * session. `json` and `body` do not go together.
 */
export type ClientInit = Omit<RequestInit, "body" | "headers"> & {
  readonly headers?: Readonly<Record<string, string | null>>;
} & (
    | {
        /**
         * The body, serialized with `JSON.stringify` and sent as
         * `application/json`.
         */
        readonly json?: unknown;
        readonly body?: never;
      }
    | {
        /** The body as it goes on the wire — for one that is not JSON. */
        readonly body?: RequestInit["body"];
        readonly json?: never;
      }
  );

/**
 * Sends a request with the client's headers and the cookies it holds, and
 * keeps the cookies the response sets.
 *
 * A redirect is answered, not followed: it may set a cookie, and `fetch`
 * does not show the responses along the way. Pass `redirect: "follow"` to
 * follow one anyway; cookies set before the last response are then lost.
 */
export interface Client {
  (path: string, init?: ClientInit): Promise<Response>;

  /** The cookies this client holds. */
  readonly cookies: CookieJar;
}

/** A cookie as the jar keeps it: the value as it travels. */
interface Held {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly expiresAt: number | undefined;
}

/**
 * Builds a client of the server whose address `base` returns.
 *
 * The address is asked for on every request rather than once: a client of
 * a server that has stopped then says so, as the server's own request
 * function does, instead of finding nothing at an old port.
 *
 * The jar follows what browsers do, where it matters to a test of one
 * server: a response's `set-cookie` headers are all kept; a cookie is sent
 * where its `Path` matches; `Max-Age=0`, an `Expires` in the past or an
 * empty value removes it. `Domain` is ignored — there is one host — and
 * `Secure` goes over `http`, because a browser treats `localhost` as a
 * secure context.
 */
export function createClient(
  base: () => URL,
  options: ClientOptions = {},
): Client {
  const held: Held[] = [];

  const client = async (
    path: string,
    init: ClientInit = {},
  ): Promise<Response> => {
    const url = new URL(path, base());

    const { json, body, headers, ...rest } = init;

    const outgoing = new Headers();

    const cookie = cookieHeader(held, url.pathname);

    if (cookie !== "") {
      outgoing.set("cookie", cookie);
    }

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      outgoing.set(name, value);
    }

    if (json !== undefined) {
      outgoing.set("content-type", "application/json");
    }

    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value === null) {
        outgoing.delete(name);
      } else {
        outgoing.set(name, value);
      }
    }

    const res = await fetch(url, {
      redirect: "manual",
      ...rest,
      headers: outgoing,
      body: json === undefined ? body : JSON.stringify(json),
    });

    for (const setCookie of res.headers.getSetCookie()) {
      keep(held, setCookie, url.pathname);
    }

    return res;
  };

  const cookies: CookieJar = {
    get(name) {
      forgetExpired(held);

      const found = byPath(held).find((cookie) => cookie.name === name);

      return found === undefined ? undefined : decoded(found);
    },

    set(name, value, attributes = {}) {
      hold(held, {
        name,
        value: encoded(name, value),
        path: attributes.path ?? "/",
        expiresAt: undefined,
      });
    },

    delete(name) {
      for (let index = held.length - 1; index >= 0; index -= 1) {
        if (held[index]?.name === name) {
          held.splice(index, 1);
        }
      }
    },
  };

  return Object.assign(client, { cookies });
}

/**
 * The `cookie` header for a request to this path, longest paths first, as
 * RFC 6265 orders it.
 */
function cookieHeader(held: Held[], requestPath: string): string {
  forgetExpired(held);

  return byPath(held)
    .filter((cookie) => pathMatches(cookie.path, requestPath))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * Applies one `set-cookie` of a response to a request at `requestPath`.
 *
 * A header Bun cannot parse is skipped, as a browser skips it. An expired
 * cookie is held like any other and replaces the one it names: the next
 * look at the jar forgets it, as it forgets one whose time ran out later.
 */
function keep(held: Held[], setCookie: string, requestPath: string): void {
  let parsed: Bun.Cookie;

  try {
    parsed = Bun.Cookie.parse(setCookie);
  } catch {
    return;
  }

  if (parsed.name === "") {
    return;
  }

  const path = pathOf(setCookie, parsed, requestPath);

  if (parsed.value === "") {
    drop(held, parsed.name, path);

    return;
  }

  hold(held, {
    name: parsed.name,
    value: parsed.value,
    path,
    expiresAt: expiryOf(parsed),
  });
}

/**
 * The path a cookie is scoped to.
 *
 * `Bun.Cookie.parse` reports `/` for a cookie without a `Path`, where a
 * browser scopes it to the directory of the request that set it — so
 * whether the attribute was there is read from the header itself.
 */
function pathOf(
  setCookie: string,
  parsed: Bun.Cookie,
  requestPath: string,
): string {
  const declared = setCookie
    .split(";")
    .slice(1)
    .some(
      (attribute) => attribute.split("=")[0]?.trim().toLowerCase() === "path",
    );

  if (declared && parsed.path.startsWith("/")) {
    return parsed.path;
  }

  return defaultPath(requestPath);
}

/** RFC 6265, 5.1.4: the directory of the request path. */
function defaultPath(requestPath: string): string {
  const cut = requestPath.lastIndexOf("/");

  return cut <= 0 ? "/" : requestPath.slice(0, cut);
}

/**
 * RFC 6265, 5.1.4: `/api` matches `/api`, `/api/` and `/api/users`, and
 * not `/apis`.
 */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) {
    return true;
  }

  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }

  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** When the cookie expires; `Max-Age` wins over `Expires`. */
function expiryOf(parsed: Bun.Cookie): number | undefined {
  if (parsed.maxAge !== undefined) {
    return Date.now() + parsed.maxAge * 1000;
  }

  return parsed.expires?.getTime();
}

/** Replaces a cookie of the same name and path in place, or adds one. */
function hold(held: Held[], cookie: Held): void {
  const index = held.findIndex(
    (other) => other.name === cookie.name && other.path === cookie.path,
  );

  if (index === -1) {
    held.push(cookie);
  } else {
    held[index] = cookie;
  }
}

function drop(held: Held[], name: string, path: string): void {
  const index = held.findIndex(
    (cookie) => cookie.name === name && cookie.path === path,
  );

  if (index !== -1) {
    held.splice(index, 1);
  }
}

function forgetExpired(held: Held[]): void {
  const now = Date.now();

  for (let index = held.length - 1; index >= 0; index -= 1) {
    const expiresAt = held[index]?.expiresAt;

    if (expiresAt !== undefined && expiresAt <= now) {
      held.splice(index, 1);
    }
  }
}

/** Longest paths first; the sort is stable, so older cookies lead a tie. */
function byPath(held: Held[]): Held[] {
  return held.toSorted((a, b) => b.path.length - a.path.length);
}

/** The value as the application reads it, through the parser it uses. */
function decoded(cookie: Held): string {
  return (
    new Bun.CookieMap(`${cookie.name}=${cookie.value}`).get(cookie.name) ??
    cookie.value
  );
}

/** The value as `ctx.out.cookies.set` would send it. */
function encoded(name: string, value: string): string {
  return Bun.Cookie.parse(new Bun.Cookie(name, value).toString()).value;
}
