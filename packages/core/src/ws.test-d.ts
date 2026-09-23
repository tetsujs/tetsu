/**
 * Type-level tests for socket endpoints.
 *
 * @module
 */

import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { Requires } from "./context.ts";
import { hook } from "./hook.ts";
import type { SocketData } from "./ws.ts";
import { ws } from "./ws.ts";

declare function expectType<T>(value: T): void;

const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));

const Message = mockSchema<{ text: string }>();
const Query = mockSchema<{ since: number }>();

ws({
  path: "/chat/:room",
  hooks: { beforeParse: [auth] },
  schema: { message: Message, query: Query },
  open: (socket) => {
    expectType<string>(socket.data.params.room);
    expectType<string>(socket.data.user.id);
    expectType<number>(socket.data.query.since);
    // @ts-expect-error the request does not outlive the handshake
    socket.data.req;
  },
  message: (socket, message) => {
    expectType<string>(message.text);
    // @ts-expect-error the schema decides what a frame is
    expectType<Buffer>(message);
    void socket;
  },
});

ws({
  path: "/raw",
  message: (_socket, message) => {
    expectType<string | Buffer>(message);
  },
});

ws({
  path: "/orders/:id",
  close: (socket, code, reason) => {
    expectType<number>(code);
    expectType<string>(reason);
    expectType<string>(socket.data.params.id);
  },
  message: () => undefined,
});

const needsUser = hook.beforeHandle(
  (ctx: Requires<{ user: { id: string } }>) => {
    void ctx.user.id;
  },
);

ws({
  path: "/guarded",
  hooks: { beforeParse: [auth], beforeHandle: [needsUser] },
  message: () => undefined,
});

ws({
  path: "/unguarded",
  hooks: {
    // @ts-expect-error nothing provides ctx.user on this endpoint
    beforeHandle: [needsUser],
  },
  message: () => undefined,
});

// @ts-expect-error a socket path is validated like any other
ws({ path: "chat", message: () => undefined });

type ChatData = SocketData<
  "/chat/:room",
  { message: typeof Message },
  { beforeParse: readonly [typeof auth] }
>;

export type socketDataCases = [
  Expect<Equal<keyof ChatData, "params" | "user">>,
  Expect<Equal<ChatData["params"], { room: string }>>,
  Expect<Equal<ChatData["user"], { id: string }>>,
];
