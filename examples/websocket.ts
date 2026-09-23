/**
 * A chat room over WebSocket.
 *
 * The handshake is an ordinary `GET` through the ordinary pipeline, so a
 * hook guards it and what the hook contributed rides on `socket.data`.
 * Frames are checked by `schema.message`; one that fails closes the socket
 * with `1007`. Pub/sub is Bun's own.
 *
 * ```sh
 * bun examples/websocket.ts
 * bunx wscat -c 'ws://localhost:3000/chat/general?name=ada'
 * > {"text":"hello"}
 * ```
 *
 * @module
 */

import { createApp, HttpError, hook, ws } from "@tetsujs/core";
import { z } from "zod";

const named = hook.beforeParse((ctx) => {
  const name = new URL(ctx.req.url).searchParams.get("name");

  if (!name) {
    throw new HttpError(401);
  }

  return { name };
});

const Message = z.object({ text: z.string().min(1).max(500) });

class ChatController {
  room = ws({
    path: "/chat/:room",
    hooks: { beforeParse: [named] },
    schema: { message: Message },

    open: (socket) => {
      socket.subscribe(socket.data.params.room);
      socket.publish(
        socket.data.params.room,
        JSON.stringify({ joined: socket.data.name }),
      );
    },

    message: (socket, message) => {
      socket.publish(
        socket.data.params.room,
        JSON.stringify({ from: socket.data.name, text: message.text }),
      );
    },

    close: (socket) => {
      socket.unsubscribe(socket.data.params.room);
    },
  });
}

export default createApp({ routes: new ChatController() });
