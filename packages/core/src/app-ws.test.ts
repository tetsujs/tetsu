/**
 * Integration tests: WebSocket endpoints through a live server.
 *
 * The handshake runs the ordinary pipeline, so its refusals are ordinary
 * responses; what the hooks contributed becomes the socket's data; and a
 * declared message schema decides what reaches the handler.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { connect } from "../test-utils/socket.ts";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";
import { ws } from "./ws.ts";

const auth = hook.beforeParse((ctx) => {
  if (new URL(ctx.req.url).searchParams.get("token") !== "secret") {
    throw new HttpError(401, { code: "unauthorized" });
  }

  return { user: { id: "u1" } };
});

const Chat: StandardSchemaV1<unknown, { text: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const text = (value as { text?: unknown }).text;

      return typeof text === "string"
        ? { value: { text } }
        : { issues: [{ message: "text must be a string", path: ["text"] }] };
    },
  },
};

/**
 * A schema that reports its path the other way the specification allows:
 * as `{ key }` segments rather than bare keys, with an array index among
 * them.
 */
const SegmentedPath: StandardSchemaV1<unknown, { items: { text: string }[] }> =
  {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => ({
        issues: [
          {
            message: "text must be a string",
            path: [{ key: "items" }, { key: 0 }, "text"],
          },
        ],
      }),
    },
  };

const broke = new Error("validator backend exploded");

/** A schema whose validator breaks instead of answering. */
function brokenSchema(
  validate: () => never | Promise<never>,
): StandardSchemaV1<unknown, { text: string }> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const seen: string[] = [];

class ChatController {
  room = ws({
    path: "/chat/:room",
    hooks: { beforeParse: [auth] },
    schema: { message: Chat },
    open: (socket) => {
      socket.send(
        JSON.stringify({
          user: socket.data.user.id,
          room: socket.data.params.room,
          keys: Object.keys(socket.data).toSorted(),
        }),
      );
    },
    message: (socket, message) => {
      socket.send(JSON.stringify({ echo: message.text }));
    },
    close: (_socket, code) => {
      seen.push(`close:${code}`);
    },
  });

  raw = ws({
    path: "/raw",
    open: (socket) => socket.send("ready"),
    message: (socket, message) => {
      socket.send(typeof message === "string" ? `text:${message}` : "binary");
    },
  });

  lenient = ws({
    path: "/lenient",
    schema: { message: Chat },
    open: (socket) => socket.send("ready"),
    message: (socket, message) => socket.send(`ok:${message.text}`),
    invalid: (socket, issues) => {
      socket.send(`refused:${issues[0]?.message ?? ""}`);
    },
  });

  segmented = ws({
    path: "/segmented",
    schema: { message: SegmentedPath },
    open: (socket) => socket.send("ready"),
    message: (socket) => socket.send("unreachable"),
    invalid: (socket, issues) => {
      socket.send(JSON.stringify(issues[0]?.path));
    },
  });

  decorated = ws({
    path: "/decorated",
    hooks: {
      beforeParse: [
        hook.beforeParse((ctx) => {
          ctx.out.headers.set("x-marker", "set-by-hook");
          ctx.req.cookies?.set("sid", "from-cookiemap");

          return undefined;
        }),
      ],
    },
    open: (socket) => socket.send("ready"),
    message: (socket, message) => socket.send(String(message)),
  });

  rejecting = ws({
    path: "/rejecting",
    schema: { message: brokenSchema(async () => Promise.reject(broke)) },
    open: (socket) => socket.send("ready"),
    message: (socket) => socket.send("unreachable"),
  });

  throwing = ws({
    path: "/throwing",
    schema: {
      message: brokenSchema(() => {
        throw broke;
      }),
    },
    open: (socket) => socket.send("ready"),
    message: (socket) => socket.send("unreachable"),
  });

  failing = ws({
    path: "/failing",
    open: (socket) => {
      socket.send("ready");

      throw new Error("handler exploded");
    },
    message: (socket, message) => socket.send(String(message)),
  });
}

const request = serve(createApp({ routes: new ChatController() }));

describe("the handshake", () => {
  test("runs the route's hooks and carries what they contributed", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    expect(JSON.parse(await socket.next())).toEqual({
      user: "u1",
      room: "general",
      keys: ["params", "user"],
    });

    socket.close();
  });

  test("keeps the request out of the socket's data", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    const data = JSON.parse(await socket.next()) as { keys: string[] };

    expect(data.keys).not.toContain("req");
    expect(data.keys).not.toContain("set");
    expect(data.keys).not.toContain("server");

    socket.close();
  });

  test("a refusal is an ordinary HTTP response", async () => {
    const res = await request("/chat/general");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthorized" });
  });

  test("a plain GET on a socket path is a 426", async () => {
    const res = await request("/chat/general?token=secret");

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      status: 426,
      message: "Upgrade Required",
      error: "UPGRADE_REQUIRED",
    });
  });
});

describe("messages", () => {
  test("a declared schema validates before the handler sees them", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    await socket.next();
    socket.send(JSON.stringify({ text: "hi" }));

    expect(JSON.parse(await socket.next())).toEqual({ echo: "hi" });

    socket.close();
  });

  test("a frame the schema refuses closes with 1007", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    await socket.next();
    socket.send(JSON.stringify({ text: 42 }));

    const end = await socket.closed();

    expect(end.code).toBe(1007);
    expect(end.reason).toBe("text must be a string");
  });

  test("a frame that is not JSON closes with 1007", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    await socket.next();
    socket.send("not json at all");

    expect((await socket.closed()).reason).toBe("message is not valid JSON");
  });

  test("a binary frame is a violation of a JSON protocol", async () => {
    const socket = await connect(request, "/chat/general?token=secret");

    await socket.next();
    socket.send(new TextEncoder().encode("{}"));

    expect((await socket.closed()).reason).toContain("binary frame");
  });

  test("an invalid handler replaces the closing", async () => {
    const socket = await connect(request, "/lenient");

    await socket.next();
    socket.send(JSON.stringify({ text: 42 }));

    expect(await socket.next()).toBe("refused:text must be a string");

    socket.close();
  });

  test("an issue's path reaches invalid as the keys, whatever form the schema used", async () => {
    const socket = await connect(request, "/segmented");

    await socket.next();
    socket.send(JSON.stringify({ items: [{ text: 42 }] }));

    expect(JSON.parse(await socket.next())).toEqual(["items", 0, "text"]);

    socket.close();
  });

  test("without a schema frames arrive as they are", async () => {
    const socket = await connect(request, "/raw");

    await socket.next();
    socket.send("plain");

    expect(await socket.next()).toBe("text:plain");

    socket.send(new TextEncoder().encode("bytes"));

    expect(await socket.next()).toBe("binary");

    socket.close();
  });
});

describe("the socket's lifetime", () => {
  const errors = captureErrors();

  test("close reaches the endpoint with the code", async () => {
    seen.length = 0;

    const socket = await connect(request, "/chat/general?token=secret");

    await socket.next();
    socket.close();
    await socket.closed();

    await Bun.sleep(20);

    expect(seen).toEqual(["close:1000"]);
  });

  test("a throwing handler is logged and the socket survives", async () => {
    const socket = await connect(request, "/failing");

    expect(await socket.next()).toBe("ready");

    socket.send("still here");

    expect(await socket.next()).toBe("still here");
    expect(errors.lines.join("\n")).toContain(
      "[tetsu] websocket open handler failed:",
    );

    socket.close();
  });

  test("a schema that rejects closes with 1011 and is logged", async () => {
    const socket = await connect(request, "/rejecting");

    expect(await socket.next()).toBe("ready");

    socket.send(JSON.stringify({ text: "hi" }));

    const end = await socket.closed();

    expect(end.code).toBe(1011);
    expect(end.reason).toBe("internal error");
    expect(errors.lines.join("\n")).toContain(
      "[tetsu] websocket message schema failed:",
    );
    expect(errors.lines.join("\n")).toContain("validator backend exploded");
  });

  test("a schema that throws closes with 1011 and is logged", async () => {
    const socket = await connect(request, "/throwing");

    expect(await socket.next()).toBe("ready");

    socket.send(JSON.stringify({ text: "hi" }));

    expect((await socket.closed()).code).toBe(1011);
    expect(errors.lines.join("\n")).toContain(
      "[tetsu] websocket message schema failed:",
    );
  });

  test("what broke stays out of the close reason", async () => {
    const socket = await connect(request, "/rejecting");

    expect(await socket.next()).toBe("ready");

    socket.send(JSON.stringify({ text: "hi" }));

    expect((await socket.closed()).reason).not.toContain("exploded");
  });

  test("every event of the platform's handler is wired", () => {
    const app = createApp({ routes: new ChatController() });

    expect(
      Object.keys(app.websocket).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual(["close", "drain", "message", "open", "ping", "pong"]);
  });
});

describe("response hooks", () => {
  const ran: string[] = [];

  const decorate = hook.beforeResponse((ctx) => {
    ran.push(`beforeResponse:${ctx.res.status}`);
  });

  const observe = hook.afterResponse((ctx) => {
    ran.push(`afterResponse:${ctx.res.status}`);
  });

  class GuardedController {
    feed = ws({
      path: "/guarded",
      hooks: { beforeParse: [auth] },
      open: (socket) => socket.send("ready"),
      message: () => undefined,
    });
  }

  const guarded = serve(
    createApp({
      routes: new GuardedController(),
      hooks: { beforeResponse: [decorate], afterResponse: [observe] },
    }),
  );

  test("do not run on a successful handshake — there is no response", async () => {
    ran.length = 0;

    const socket = await connect(guarded, "/guarded?token=secret");

    expect(await socket.next()).toBe("ready");

    await Bun.sleep(20);

    expect(ran).toEqual([]);

    socket.close();
  });

  test("do run on a refused one, which is an ordinary response", async () => {
    ran.length = 0;

    const res = await guarded("/guarded");

    expect(res.status).toBe(401);

    await Bun.sleep(20);

    expect(ran).toEqual(["beforeResponse:401", "afterResponse:401"]);
  });
});

describe("the table", () => {
  test("a socket endpoint takes the GET slot of its path", () => {
    class Mixed {
      feed = ws({ path: "/feed", message: () => undefined });
      list = route({ method: "POST", path: "/feed", handler: () => ({}) });
    }

    const app = createApp({ routes: new Mixed() });

    expect(
      app.entries.map((entry) => `${entry.method} ${entry.path}`).toSorted(),
    ).toEqual(["GET /feed", "POST /feed"]);
  });

  test("a path answers either a socket or a body, never both", () => {
    class Clashing {
      feed = ws({ path: "/feed", message: () => undefined });
      also = route({ method: "GET", path: "/feed", handler: () => ({}) });
    }

    expect(() => createApp({ routes: new Clashing() })).toThrow(
      "Duplicate route: GET /feed",
    );
  });

  test("the entry says which endpoint it serves", () => {
    class Mixed {
      feed = ws({ path: "/feed", message: () => undefined });
    }

    const [entry] = createApp({ routes: new Mixed() }).entries;

    expect(entry?.ws).toBeDefined();
    expect(entry?.name).toBe("feed");
  });
});

describe("what a hook can decorate a handshake with", () => {
  /**
   * The headers of an accepted upgrade.
   *
   * Spoken over a plain socket because nothing else exposes them: `fetch`
   * refuses the status, and Bun's `WebSocket` hands back no response.
   */
  const handshake = (path: string): Promise<Record<string, string>> => {
    const url = new URL(path, request.url);

    return new Promise((resolve, reject) => {
      void Bun.connect({
        hostname: url.hostname,
        port: Number(url.port),
        socket: {
          open: (connection) => {
            connection.write(
              `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n` +
                "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
                "Sec-WebSocket-Version: 13\r\n\r\n",
            );
          },
          data: (connection, data) => {
            const head = new TextDecoder().decode(data).split("\r\n\r\n")[0];
            const headers: Record<string, string> = {};

            for (const line of (head ?? "").split("\r\n").slice(1)) {
              const at = line.indexOf(":");

              if (at > 0) {
                headers[line.slice(0, at).toLowerCase()] = line
                  .slice(at + 1)
                  .trim();
              }
            }

            connection.end();
            resolve(headers);
          },
          error: () => reject(new Error("no handshake")),
        },
      });
    });
  };

  // Pins today's split rather than endorsing it: a cookie set the canonical
  // way survives the upgrade, a header set through `ctx.out` does not.
  // HANDOFF §8 promises `ctx.out.headers` on "any outgoing response", and
  // the 101 frame is one on the wire, so one of the two has to give.
  test("a cookie reaches the client, a set header does not", async () => {
    const headers = await handshake("/decorated");

    expect(headers["set-cookie"]).toContain("sid=from-cookiemap");
    expect(headers["x-marker"]).toBeUndefined();
  });
});
