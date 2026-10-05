/**
 * Test helper: serves an application the way production does.
 *
 * Routing belongs to Bun's native router, which is only reachable over a
 * real socket — `server.fetch()` bypasses it. Integration tests therefore
 * run against a live server on an ephemeral port, which also means they
 * exercise exactly the path a deployed application takes. The cost is
 * ~0.07 ms per request and ~0.8 ms per server.
 *
 * @module
 */

import { afterAll } from "bun:test";
import type { App } from "../src/index.ts";
import type { Client, ClientOptions } from "./client.ts";
import { createClient } from "./client.ts";

/** What stopped a server — the first thing a request to it is told. */
type Stopper = "cleanup" | "stop" | "stopServers";

/** How to stop each server {@link serve} started that is still running. */
const running = new Set<(by: Stopper) => void>();

/**
 * Sends a request to a served application.
 *
 * Carries the server's base URL, which a WebSocket client needs: `fetch`
 * takes a path, `new WebSocket(...)` does not.
 *
 * Once the server has stopped, a request, a client's request and `url`
 * throw, saying what stopped it. A bare `ConnectionRefused` named neither
 * the server nor the reason.
 *
 * @param path - Path with optional query string, e.g. `/users/1?full=true`.
 */
export interface RequestFn {
  (path: string, init?: RequestInit): Promise<Response>;

  /** Where the server is listening. */
  readonly url: URL;

  /**
   * Stops the server now. With `{ stop: false }`, this is what the test
   * file calls in its own `afterAll`.
   *
   * It does not wait for the server to finish: Bun's `stop()` resolves
   * only once every connection is gone, and a WebSocket the server itself
   * closed never leaves that list — awaited, it would hold the hook until
   * the runner's timeout. Reproduced on a bare `Bun.serve`, without this
   * framework.
   */
  stop(): void;

  /**
   * A client of this server with its own default headers and a cookie
   * jar — for a test that signs in and then acts as that user. One per
   * test keeps a test's session out of the next.
   *
   * @example
   * ```ts
   * const client = request.client({ headers: { "x-real-ip": "10.0.0.7" } });
   *
   * await client("/session", { method: "POST", json: { email } });
   *
   * expect((await client("/me")).status).toBe(200);
   * expect(client.cookies.get("session")).toBeDefined();
   * ```
   */
  client(options?: ClientOptions): Client;
}

/** Where the test server listens. */
export interface ServeOptions {
  /**
   * The address to listen on. Bun's default when absent.
   *
   * The default listens on both IPv4 and IPv6, and reports a client that
   * connects over IPv4 as `::ffff:127.0.0.1`: `"127.0.0.1"` is how a test
   * becomes an IPv4 client, to check what compares against `127.0.0.1` —
   * a trusted proxy, an allow-list. The request function goes to the
   * address the server listens on.
   */
  readonly hostname?: string;

  /**
   * Whether the server stops by itself, with an `afterAll` registered
   * where `serve()` is called. On by default.
   *
   * Off, the server runs until {@link RequestFn.stop} or
   * {@link stopServers}. That is what a server started in `beforeAll`
   * needs: Bun runs an `afterAll` registered inside a hook as soon as the
   * hook returns, before any test. So does one a teardown of the file's own
   * still talks to: Bun runs `afterAll` hooks in the order they were
   * registered, and the one `serve()` registers comes first.
   *
   * @example
   * ```ts
   * let request: RequestFn;
   *
   * beforeAll(async () => {
   *   request = serve(createApp({ routes: notes(await openDatabase()) }), {
   *     stop: false,
   *   });
   * });
   *
   * afterAll(() => request.stop());
   * ```
   */
  readonly stop?: boolean;
}

/**
 * Serves an application on an ephemeral port and returns a request function
 * bound to it.
 *
 * Cleanup is automatic under `bun test`: each server registers its own
 * `afterAll` where `serve` is called, and Bun runs it when that scope ends
 * — the file, the `describe`, or the test, a `beforeEach` counting as its
 * test. A test file cannot forget it.
 *
 * Two places meet that cleanup too early. In `beforeAll`: Bun runs an
 * `afterAll` registered inside a hook as soon as the hook returns, so the
 * server would stop before the first test — await the setup at the top
 * level of the file and call `serve` after it. And in an `afterAll` of
 * the file's own registered after `serve`: Bun runs `afterAll` hooks in
 * the order they were registered, so it runs once the server has stopped.
 * Either way, `{ stop: false }` leaves the stop to an `afterAll` of your
 * own. A server used after it stopped says what stopped it.
 *
 * Outside the test runner `afterAll` throws; the error is swallowed and
 * the caller owns the lifetime via {@link RequestFn.stop} or
 * {@link stopServers}.
 *
 * @example
 * ```ts
 * const request = serve(createApp({ routes: new UsersController(users) }));
 *
 * test("lists users", async () => {
 *   const res = await request("/users");
 *
 *   expect(res.status).toBe(200);
 * });
 * ```
 *
 * @example An IPv4 client
 * ```ts
 * const request = serve(app, { hostname: "127.0.0.1" });
 * ```
 */
export function serve(app: App, options: ServeOptions = {}): RequestFn {
  const server = Bun.serve({
    ...app,
    port: 0,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });

  let stoppedBy: Stopper | undefined;

  const stop = (by: Stopper): void => {
    if (stoppedBy !== undefined) {
      return;
    }

    stoppedBy = by;
    running.delete(stop);

    // Not awaited, for the reason `RequestFn.stop` gives.
    void server.stop(true);
  };

  running.add(stop);

  if (options.stop !== false) {
    try {
      afterAll(() => stop("cleanup"));
    } catch {
      void 0;
    }
  }

  /** The server's address, or, once it has stopped, what stopped it. */
  const address = (): URL => {
    if (stoppedBy !== undefined) {
      throw new Error(stoppedMessage(server.url, stoppedBy));
    }

    return server.url;
  };

  const request = async (path: string, init?: RequestInit) =>
    fetch(new URL(path, address()).href, init);

  const members = Object.assign(request, {
    client: (clientOptions?: ClientOptions) =>
      createClient(address, clientOptions),
    stop: () => stop("stop"),
  });

  return Object.defineProperty(members, "url", {
    get: address,
    enumerable: true,
    configurable: true,
  }) as RequestFn;
}

/** Stops every server started by {@link serve} that is still running. */
export function stopServers(): void {
  for (const stop of [...running]) {
    stop("stopServers");
  }
}

/**
 * What a request to a stopped server is told: what stopped it, and, when
 * it was the `afterAll` `serve()` registers, the two places that meet it
 * too early — a `beforeAll` that calls `serve()`, and an `afterAll` of the
 * test file's own, which Bun runs after it when it was registered later.
 */
function stoppedMessage(url: URL, by: Stopper): string {
  const stopped = `serve(): the server at ${url.origin} has stopped`;

  switch (by) {
    case "stop":
      return `${stopped}: request.stop() stopped it`;
    case "stopServers":
      return `${stopped}: stopServers() stopped it`;
    case "cleanup":
      return `${stopped}: the afterAll serve() registers stopped it when the file, describe, test or hook that called serve() ended — right after a beforeAll that calls serve(), before any test, and before an afterAll registered after serve(). Await the setup at the top level and call serve() after it, or pass { stop: false } and call request.stop() once you are done with the server`;
  }
}
