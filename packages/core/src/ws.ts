/**
 * WebSocket endpoints.
 *
 * A socket endpoint is declared like a route and lives in the same table,
 * but it is not a route: it answers no method, returns no body and has no
 * response schema. It is declared by its own factory so that `Method`,
 * the `Allow` header of a `405` and the generated documentation keep
 * describing HTTP and nothing else.
 *
 * The handshake is an ordinary `GET` and runs the ordinary pipeline —
 * `beforeParse`, validation of `params`/`query`/`headers`, `beforeHandle`
 * — so authentication, rate limiting and tenant lookup are the same hooks
 * as everywhere else. What those hooks contributed becomes the socket's
 * `data`, typed: an `auth` hook that adds `ctx.user` gives every handler a
 * typed `socket.data.user`.
 *
 * A refused handshake is a normal HTTP response and travels the normal
 * path, response hooks included. A successful one produces no response at
 * all, so those hooks do not run — `open` is where that story continues.
 *
 * @example
 * ```ts
 * export const chatController = controller("Chat", () => ({
 *   room: ws({
 *     path: "/chat/:room",
 *     hooks: { beforeParse: [auth] },
 *     schema: { message: ChatMessage },
 *     open: (socket) => socket.subscribe(socket.data.params.room),
 *     message: (socket, message) => {
 *       socket.publish(socket.data.params.room, JSON.stringify({
 *         from: socket.data.user.id,
 *         text: message.text,
 *       }));
 *     },
 *   }),
 * }));
 * ```
 *
 * @module
 */

import type { ServerWebSocket } from "bun";
import type { BaseCtx, SchemaConfig } from "./context.ts";
import type { ValidationIssue } from "./error.ts";
import { httpError } from "./error.ts";
import { contextSnapshot } from "./guard.ts";
import type { Prettify } from "./internal.ts";
import type { ValidatePath } from "./path.ts";
import type { PipelineCtx } from "./pipeline.ts";
import { upgraded } from "./pipeline.ts";
import type { AnySchema, InferOutput } from "./schema.ts";
import { endpointKey } from "./socket.ts";
import type {
  HandlerCtx,
  HooksConfig,
  HooksInput,
  ValidateHooks,
} from "./stack.ts";

/**
 * Schemas of a socket endpoint.
 *
 * The handshake carries no body, so there is none to declare; `message`
 * describes what travels over the open socket instead.
 */
export interface WsSchemaConfig {
  /** Narrows path parameters, as on a route. */
  readonly params?: AnySchema;

  /** Validates the query string of the handshake. */
  readonly query?: AnySchema;

  /** Validates the headers of the handshake. */
  readonly headers?: AnySchema;

  /**
   * Validates every text message.
   *
   * Declaring it says the protocol is JSON: a text frame is parsed and
   * checked before `message` sees it, and a frame that is neither valid
   * JSON nor valid against the schema never reaches the handler. Binary
   * frames are a protocol violation under such a declaration — a JSON
   * protocol has no place for them — and are refused the same way.
   */
  readonly message?: AnySchema;
}

/**
 * What the socket's `data` holds: everything the handshake established,
 * minus what belongs to the request that is now over.
 *
 * The `Request` itself is deliberately absent. A socket outlives its
 * handshake by minutes or hours, and holding the request would hold its
 * headers and body with it — a hook that needs something from the request
 * contributes it as a field.
 */
export type SocketData<
  Path extends string,
  S extends WsSchemaConfig,
  H,
> = Prettify<Omit<HandlerCtx<Path, S & SchemaConfig, H>, keyof BaseCtx>>;

/** The socket a handler receives, carrying the typed handshake data. */
export type Socket<
  Path extends string,
  S extends WsSchemaConfig,
  H,
> = ServerWebSocket<SocketData<Path, S, H>>;

/**
 * What a text frame is by the time it reaches `message`: the schema's
 * output when one is declared, and the raw frame when none is.
 */
export type MessageOf<S extends WsSchemaConfig> =
  S["message"] extends infer M extends AnySchema
    ? InferOutput<M>
    : string | Buffer;

/**
 * The configuration accepted by `ws()`.
 *
 * Every handler of Bun's own `WebSocketHandler` is here, typed against the
 * endpoint's data — nothing is hidden, and nothing is wrapped.
 *
 * The handlers return `unknown` rather than `void | Promise<void>`, which
 * is what the platform declares: `socket.send()` returns a number, so
 * `open: (socket) => socket.send("ready")` would not compile against a
 * `void` union. The value is ignored either way; a promise is awaited only
 * to catch its rejection.
 */
export interface WsConfig<
  Path extends string,
  S extends WsSchemaConfig,
  H extends HooksInput,
> {
  /** Path of the handshake, `:param` segments included. */
  readonly path: Path & ValidatePath<Path>;

  /** Schemas of the handshake and of the messages. */
  readonly schema?: S;

  /** Documentation metadata; socket endpoints are absent from OpenAPI. */
  readonly docs?: { readonly summary?: string; readonly description?: string };

  /** Lifecycle hooks of the handshake. */
  readonly hooks?: H & ValidateHooks<H, Path, S & SchemaConfig>;

  /** The socket is open and has its data. */
  readonly open?: (socket: Socket<Path, S, H>) => unknown;

  /** A frame arrived — validated, when a `message` schema says so. */
  readonly message?: (
    socket: Socket<Path, S, H>,
    message: MessageOf<S>,
  ) => unknown;

  /** The socket closed, with the code and reason the peer gave. */
  readonly close?: (
    socket: Socket<Path, S, H>,
    code: number,
    reason: string,
  ) => unknown;

  /** Backpressure eased: the socket is writable again. */
  readonly drain?: (socket: Socket<Path, S, H>) => unknown;

  /** A ping frame arrived. */
  readonly ping?: (socket: Socket<Path, S, H>, data: Buffer) => unknown;

  /** A pong frame arrived. */
  readonly pong?: (socket: Socket<Path, S, H>, data: Buffer) => unknown;

  /**
   * A frame that the `message` schema refused.
   *
   * Without one the socket is closed with `1007` — the code the protocol
   * reserves for a payload that does not fit the endpoint's contract.
   * Ignoring such a frame would leave a client sending malformed data with
   * nothing telling it so.
   */
  readonly invalid?: (
    socket: Socket<Path, S, H>,
    issues: readonly ValidationIssue[],
  ) => unknown;
}

const wsBrand: unique symbol = Symbol("tetsu.ws");

/** A declared socket endpoint, held as a controller field. */
export interface WsDef<
  Path extends string = string,
  S extends WsSchemaConfig = WsSchemaConfig,
  H extends HooksInput = HooksConfig,
> extends WsConfig<Path, S, H> {
  readonly [wsBrand]: true;
}

/**
 * Declares a WebSocket endpoint.
 *
 * @example
 * ```ts
 * export const feed = ws({
 *   path: "/feed",
 *   open: (socket) => socket.send("ready"),
 *   message: (socket, message) => socket.send(message),
 * });
 * ```
 */
export function ws<
  const Path extends string,
  const S extends WsSchemaConfig = WsSchemaConfig,
  const H extends HooksInput = HooksConfig,
>(config: WsConfig<Path, S, H>): WsDef<Path, S, H> {
  return { ...config, [wsBrand]: true } as WsDef<Path, S, H>;
}

/**
 * The handler the route table runs for a handshake.
 *
 * By the time it is called the hooks have run and the parts are
 * validated, so the context is exactly what the socket should carry.
 * `upgrade` refuses a request that is not a handshake, and that refusal is
 * an ordinary `426` travelling the ordinary path.
 *
 * Internal to the core.
 */
export function upgradeHandler(def: WsDef): (ctx: never) => unknown {
  return (raw: never) => {
    const ctx = raw as unknown as PipelineCtx;

    const accepted = ctx.server.upgrade(ctx.req, {
      data: { ...contextSnapshot(ctx), [endpointKey]: def },
    });

    if (!accepted) {
      throw httpError(426);
    }

    return upgraded;
  };
}

/** Whether a value is a socket endpoint declared by {@link ws}. */
export function isWs(value: unknown): value is WsDef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[wsBrand] === true
  );
}
