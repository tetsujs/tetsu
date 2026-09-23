/**
 * Test helper: a WebSocket client for a served application.
 *
 * Sockets are asynchronous in both directions, so a test that reads them
 * with callbacks becomes a nest of timeouts. This turns a connection into
 * something a test can await: the next message, or the close and its code.
 *
 * @module
 */

import type { RequestFn } from "./server.ts";

/** How long any single wait may take before the test is told it failed. */
const timeoutMs = 2_000;

/** A connection a test drives step by step. */
export interface SocketSession {
  /** Sends a frame. */
  send: (data: string | ArrayBufferView) => void;

  /** Resolves with the next frame the server sends. */
  next: () => Promise<string>;

  /** Resolves when the connection ends, with the code and reason. */
  closed: () => Promise<{ code: number; reason: string }>;

  /** Closes from this side. */
  close: () => void;
}

/**
 * Opens a connection to a served application and waits until it is open.
 *
 * Rejects when the handshake is refused, which is what a test asserting a
 * refusal should check over HTTP instead — a refused upgrade is an
 * ordinary response.
 */
export function connect(
  request: RequestFn,
  path: string,
): Promise<SocketSession> {
  const url = new URL(path, request.url);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url.href);
  const received: string[] = [];
  const waiting: ((message: string) => void)[] = [];

  let ending: { code: number; reason: string } | undefined;
  const endWaiters: ((end: { code: number; reason: string }) => void)[] = [];

  socket.onmessage = (event) => {
    const message = String(event.data);
    const waiter = waiting.shift();

    if (waiter) {
      waiter(message);
    } else {
      received.push(message);
    }
  };

  socket.onclose = (event) => {
    ending = { code: event.code, reason: event.reason };

    for (const waiter of endWaiters.splice(0)) {
      waiter(ending);
    }
  };

  const session: SocketSession = {
    send: (data) => socket.send(data as string),

    next: () =>
      withTimeout("a message", (resolve) => {
        const buffered = received.shift();

        if (buffered !== undefined) {
          resolve(buffered);

          return;
        }

        waiting.push(resolve);
      }),

    closed: () =>
      withTimeout<{ code: number; reason: string }>("the close", (resolve) => {
        if (ending) {
          resolve(ending);

          return;
        }

        endWaiters.push(resolve);
      }),

    close: () => socket.close(),
  };

  return withTimeout("the connection to open", (resolve, reject) => {
    socket.onopen = () => resolve(session);
    socket.onerror = () => reject(new Error(`handshake failed for ${path}`));
  });
}

function withTimeout<T>(
  what: string,
  start: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);

    start(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
