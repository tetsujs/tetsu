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

const running: { stop: (closeActiveConnections?: boolean) => void }[] = [];

/**
 * Sends a request to a served application.
 *
 * Carries the server's base URL, which a WebSocket client needs: `fetch`
 * takes a path, `new WebSocket(...)` does not.
 *
 * @param path - Path with optional query string, e.g. `/users/1?full=true`.
 */
export interface RequestFn {
  (path: string, init?: RequestInit): Promise<Response>;

  /** Where the server is listening. */
  readonly url: URL;
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
}

/**
 * Serves an application on an ephemeral port and returns a request function
 * bound to it.
 *
 * Cleanup is automatic under `bun test`: each server registers its own
 * `afterAll`, scoped to wherever `serve` was called — a test file cannot
 * forget it. The stop is not awaited; see the note at the call. Outside the test runner `afterAll` throws; the error is
 * swallowed and the caller owns the lifetime via {@link stopServers}.
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

  running.push(server);

  try {
    afterAll(() => {
      // Not returned on purpose: `stop()` resolves only once every
      // connection is gone, and a WebSocket the server itself closed never
      // leaves that list — awaiting it hangs the hook until the runner's
      // timeout. Reproduced on a bare `Bun.serve`, without this framework.
      void server.stop(true);
    });
  } catch {
    void 0;
  }

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(new URL(path, server.url).href, init);

  return Object.assign(request, { url: server.url });
}

/** Stops every server started by {@link serve} that is still running. */
export function stopServers(): void {
  for (const server of running) {
    server.stop(true);
  }

  running.length = 0;
}
