/**
 * The server's single WebSocket handler.
 *
 * Bun gives a server one handler for every socket it holds, so the
 * endpoint a socket belongs to travels with the socket itself: the
 * handshake stores it in `data` under a symbol, invisible to the
 * application's own fields, and every event is dispatched through it.
 *
 * Nothing here wraps the socket. Handlers receive Bun's own
 * `ServerWebSocket` — `send`, `subscribe`, `publish`, `cork` and the rest
 * are the platform's, typed only in what the handshake put into `data`.
 *
 * Internal to the core.
 *
 * @module
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ValidationIssue } from "./error.ts";
import { isThenable } from "./internal.ts";
import type { Reporter } from "./report.ts";
import type { AnySchema, StandardResult } from "./schema.ts";
import { normalizePath } from "./validate.ts";
import type { WsDef } from "./ws.ts";

/** Where a socket keeps the endpoint that accepted it. */
export const endpointKey: unique symbol = Symbol("tetsu.ws.endpoint");

/** What every socket of this framework carries in `data`. */
export type SocketState = Record<string, unknown> & {
  readonly [endpointKey]: WsDef;
};

type AnySocket = ServerWebSocket<SocketState>;

/**
 * The endpoint's handlers as the dispatcher can call them.
 *
 * The one place a socket's erased data meets handlers typed for it: a
 * `ws()` declaration types every handler against its own path, schemas and
 * hooks, while the server holds one handler for sockets of every endpoint.
 * The declaration was checked where it was written, so calling it with the
 * socket it came from is safe by construction — the same trade `call()`
 * makes for hooks in `pipeline.ts`.
 */
interface Handlers {
  readonly open?: (socket: AnySocket) => unknown;
  readonly message?: (socket: AnySocket, message: unknown) => unknown;
  readonly close?: (socket: AnySocket, code: number, reason: string) => unknown;
  readonly drain?: (socket: AnySocket) => unknown;
  readonly ping?: (socket: AnySocket, data: Buffer) => unknown;
  readonly pong?: (socket: AnySocket, data: Buffer) => unknown;
  readonly invalid?: (
    socket: AnySocket,
    issues: readonly ValidationIssue[],
  ) => unknown;
}

/**
 * Builds the handler every socket of the server runs through.
 *
 * One handler, however many endpoints: the dispatch is a property lookup
 * on the socket's own data, which is what Bun's design asks for.
 *
 * `report` is the application's: a handler that throws has no response to
 * become, so its failure goes where every such failure goes.
 */
export function socketHandler(report: Reporter): WebSocketHandler<SocketState> {
  return {
    open: (socket) => {
      run(report, socket, "open", (on) => on.open?.(socket));
      follow(report, socket);
    },

    message: (socket, message) => deliver(report, socket, message),

    close: (socket, code, reason) => {
      unfollow(socket);
      run(report, socket, "close", (on) => on.close?.(socket, code, reason));
    },

    drain: (socket) => run(report, socket, "drain", (on) => on.drain?.(socket)),

    ping: (socket, data) =>
      run(report, socket, "ping", (on) => on.ping?.(socket, data)),

    pong: (socket, data) =>
      run(report, socket, "pong", (on) => on.pong?.(socket, data)),
  };
}

/**
 * The open sockets waiting on each `until` signal, and what closes them.
 *
 * The listener is on a signal only while a socket waits on it: `draining`
 * lives as long as the process, and a listener left on it would hold every
 * socket that ever waited.
 */
const followed = new WeakMap<
  AbortSignal,
  { readonly sockets: Set<AnySocket>; readonly close: () => void }
>();

/** The signal each open socket waits on, so its close can let go of it. */
const waitingOn = new WeakMap<AnySocket, AbortSignal>();

/** The code a socket closes with when its server is going away. */
const goingAway = 1001;

/**
 * Starts closing a socket with its endpoint's `until` — at once, when the
 * signal has already fired: a socket opened while the server drains would
 * otherwise hold the stop it was opened into.
 */
function follow(report: Reporter, socket: AnySocket): void {
  const declared = endpointOf(socket).until;

  if (declared === undefined || socket.readyState !== socketOpen) {
    return;
  }

  let until: AbortSignal | undefined;

  try {
    until = typeof declared === "function" ? declared() : declared;
  } catch (error) {
    report({ source: "websocket", error }, "websocket until failed");

    return;
  }

  if (until === undefined) {
    return;
  }

  if (until.aborted) {
    socket.close(goingAway, "going away");

    return;
  }

  let entry = followed.get(until);

  if (entry === undefined) {
    const signal = until;
    const sockets = new Set<AnySocket>();
    const close = (): void => {
      followed.delete(signal);

      for (const open of sockets) {
        open.close(goingAway, "going away");
      }
    };

    entry = { sockets, close };
    followed.set(signal, entry);
    signal.addEventListener("abort", close, { once: true });
  }

  entry.sockets.add(socket);
  waitingOn.set(socket, until);
}

/** Lets go of a socket that closed, and of its signal once nothing waits. */
function unfollow(socket: AnySocket): void {
  const until = waitingOn.get(socket);

  if (until === undefined) {
    return;
  }

  waitingOn.delete(socket);

  const entry = followed.get(until);

  if (entry === undefined) {
    return;
  }

  entry.sockets.delete(socket);

  if (entry.sockets.size === 0) {
    followed.delete(until);
    until.removeEventListener("abort", entry.close);
  }
}

/**
 * The last frame of a socket still waiting for its turn: the next frame is
 * acted on after it.
 *
 * Every frame's check starts the moment it arrives, so a socket's frames
 * are checked side by side, but what each came to — a delivery, a
 * refusal, a failed check — happens in the order they arrived. Without
 * the line a frame checked faster overtook one checked slower: the handler
 * got them out of order, or got a frame after `close`, with nothing it
 * could do about either. Bun calls `message` in order; a schema must not
 * undo that. A socket that is gone takes its entry with it.
 */
const pending = new WeakMap<AnySocket, Promise<void>>();

/**
 * Delivers one frame, validating it when the endpoint declared a message
 * schema.
 *
 * A frame waits only for its own check or for an earlier frame still
 * waiting; with a synchronous schema — the common case — neither happens,
 * and the frame is acted on at once.
 */
function deliver(
  report: Reporter,
  socket: AnySocket,
  message: string | Buffer,
): void {
  const schema = endpointOf(socket).schema?.message;

  if (!schema) {
    run(report, socket, "message", (on) => on.message?.(socket, message));

    return;
  }

  const outcome = inspect(schema, message);
  const before = pending.get(socket);

  if (before === undefined && !isThenable(outcome)) {
    act(report, socket, outcome);

    return;
  }

  const turn: Promise<Outcome> =
    before === undefined
      ? Promise.resolve(outcome)
      : before.then(() => outcome);

  /**
   * One `then` with both handlers, and the entry cleared inside them: a
   * `catch` and a `finally` on top cost a socket with an asynchronous
   * schema two more promises a frame, about 70 ns. The `try` stands in for
   * the `catch`: a rejection left on the tail would reach no one, and Bun
   * ends the process on an unhandled one.
   */
  const tail: Promise<void> = turn.then(
    (ready) => {
      forget(socket, tail);

      try {
        act(report, socket, ready);
      } catch (error) {
        failed(report, socket, error);
      }
    },
    (error: unknown) => {
      forget(socket, tail);
      failed(report, socket, error);
    },
  );

  pending.set(socket, tail);
}

/** Clears the socket's entry, unless a later frame has taken it since. */
function forget(socket: AnySocket, tail: Promise<void>): void {
  if (pending.get(socket) === tail) {
    pending.delete(socket);
  }
}

/** What a frame came to: what its check said, or that the check failed. */
type Outcome = Checked | { readonly failure: unknown };

/**
 * Parses and checks one frame, now; a promise when the check is
 * asynchronous, which resolves rather than rejects — a failed check is an
 * outcome to act on in its turn like the others.
 *
 * A declaration of that schema is a declaration that the protocol is
 * JSON, so a binary frame is as much a violation as unparsable text: both
 * take the refusal path rather than reaching a handler typed for neither.
 */
function inspect(
  schema: AnySchema,
  message: string | Buffer,
): Outcome | Promise<Outcome> {
  if (typeof message !== "string") {
    return {
      issues: [
        { message: "a binary frame is not valid for this endpoint", path: [] },
      ],
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(message);
  } catch {
    return { issues: [{ message: "message is not valid JSON", path: [] }] };
  }

  try {
    const checked = check(schema, parsed);

    return isThenable(checked)
      ? checked.then(undefined, (failure: unknown) => ({ failure }))
      : checked;
  } catch (failure) {
    return { failure };
  }
}

/**
 * Acts on what a frame came to: delivers it, refuses it, or ends the
 * socket for a check that failed.
 *
 * A socket no longer open — closed by what an earlier frame came to, by a
 * handler, or by the client while this frame waited — gets nothing more:
 * its `close` has run, and a handler that tidied up there must not see a
 * frame after it. A check that failed then is not reported either: the
 * socket it would end is already gone.
 */
function act(report: Reporter, socket: AnySocket, outcome: Outcome): void {
  if (socket.readyState !== socketOpen) {
    return;
  }

  if ("failure" in outcome) {
    failed(report, socket, outcome.failure);

    return;
  }

  if ("issues" in outcome) {
    refuse(report, socket, outcome.issues);

    return;
  }

  run(report, socket, "message", (on) => on.message?.(socket, outcome.value));
}

/** `WebSocket.OPEN`: the one state in which a frame is still acted on. */
const socketOpen = 1;

/** A frame that passed the schema, or the reasons it did not. */
type Checked =
  | { readonly value: unknown }
  | { readonly issues: ValidationIssue[] };

/**
 * Runs one frame through the endpoint's message schema.
 *
 * Awaits the validator only when it is asynchronous, the way every other
 * schema call in the framework does.
 */
function check(schema: AnySchema, value: unknown): Checked | Promise<Checked> {
  const outcome = schema["~standard"].validate(value);

  return isThenable(outcome) ? outcome.then(asChecked) : asChecked(outcome);
}

/** Reshapes a Standard Schema result into what the dispatcher acts on. */
function asChecked(result: StandardResult<unknown>): Checked {
  if (!result.issues) {
    return { value: result.value };
  }

  return {
    issues: result.issues.map((issue) => ({
      message: issue.message,
      path: normalizePath(issue),
    })),
  };
}

/**
 * Ends a socket whose message schema failed instead of answering.
 *
 * A validator that throws — or rejects, which one reaching for a database
 * or a cache can do — is the framework's own failure, not the client's, so
 * `invalid` is not for it: that handler is typed for the issues a schema
 * found, and there are none. `1011` is the code the protocol reserves for
 * a server that met an unexpected condition, the socket's answer to the
 * `500` the same failure produces over HTTP; `1007` would blame a frame
 * that may well have been valid.
 *
 * Closing rather than dropping the frame, for the reason `refuse` gives:
 * a validator that fails fails for every frame, so a surviving socket is
 * one the client talks into forever. The reason carries no detail — what
 * broke is for the log, not for the client, the same trade the `500`
 * envelope makes.
 *
 * Without this the rejection would reach no one: Bun ends the process on
 * an unhandled one, taking every other socket with it.
 */
function failed(report: Reporter, socket: AnySocket, error: unknown): void {
  report({ source: "websocket", error }, "websocket message schema failed");

  socket.close(1011, "internal error");
}

/**
 * Refuses a frame the endpoint's schema rejected.
 *
 * Closing is the default because the alternative — dropping the frame —
 * leaves a client sending malformed data with nothing to tell it so.
 * `1007` is the code the protocol reserves for exactly this.
 */
function refuse(
  report: Reporter,
  socket: AnySocket,
  issues: readonly ValidationIssue[],
): void {
  if (endpointOf(socket).invalid) {
    run(report, socket, "invalid", (on) => on.invalid?.(socket, issues));

    return;
  }

  socket.close(1007, issues[0]?.message ?? "invalid message");
}

/**
 * Runs one socket handler, keeping its failure off the connection.
 *
 * There is no response to map an error onto and no request left to hand
 * to `onError`, so a throwing handler is reported and the socket lives on
 * — the same trade `afterResponse` makes.
 */
function run(
  report: Reporter,
  socket: AnySocket,
  event: string,
  call: (on: Handlers) => unknown,
): void {
  try {
    const result = call(endpointOf(socket) as unknown as Handlers);

    if (isThenable(result)) {
      void Promise.resolve(result).catch((error: unknown) => {
        report(
          { source: "websocket", error },
          `websocket ${event} handler failed`,
        );
      });
    }
  } catch (error) {
    report({ source: "websocket", error }, `websocket ${event} handler failed`);
  }
}

function endpointOf(socket: AnySocket): WsDef {
  return socket.data[endpointKey];
}
