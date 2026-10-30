/**
 * The events of a response: the parser against the rules of the event
 * stream format, however the body is cut into chunks, and `res.events`
 * against a live `sse()` — what it reads, and that leaving the loop or
 * aborting the request ends the stream on the server.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, httpError, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { SseSummary } from "@tetsujs/sse";
import { sse } from "@tetsujs/sse";
import { z } from "zod";
import { events } from "./events.ts";
import type { Raw, ReceivedEvent } from "./index.ts";
import { createClient, unwrap } from "./index.ts";

const encoder = new TextEncoder();

/** A response whose body arrives in these chunks, each a string or bytes. */
function chunked(chunks: readonly (string | Uint8Array)[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }

      controller.close();
    },
  });

  return new Response(body);
}

async function all(response: Response): Promise<ReceivedEvent[]> {
  const read: ReceivedEvent[] = [];

  for await (const event of events(response)) {
    read.push(event);
  }

  return read;
}

const parse = (stream: string): Promise<ReceivedEvent[]> =>
  all(chunked([stream]));

describe("the format", () => {
  test("an event is its data, as text and as JSON", async () => {
    expect(await parse('data: {"a":1}\n\n')).toStrictEqual([
      { data: { a: 1 }, text: '{"a":1}' },
    ]);
  });

  test("data that is not JSON is undefined, its text as it came", async () => {
    expect(await parse("data: hello\n\n")).toStrictEqual([
      { data: undefined, text: "hello" },
    ]);
  });

  test("the text keeps what the space after the colon leaves: one is cut, the next is data", async () => {
    expect(await parse("data:  42\n\ndata:x\n\n")).toStrictEqual([
      { data: 42, text: " 42" },
      { data: undefined, text: "x" },
    ]);
  });

  test("the lines of the data are joined with a line feed", async () => {
    expect(await parse("data: a\ndata:\ndata: b\n\n")).toStrictEqual([
      { data: undefined, text: "a\n\nb" },
    ]);
  });

  test("a line ends at CRLF, LF or CR", async () => {
    expect(
      await parse("data: a\r\ndata: b\rdata: c\n\r\ndata: d\r\r"),
    ).toStrictEqual([
      { data: undefined, text: "a\nb\nc" },
      { data: undefined, text: "d" },
    ]);
  });

  test("a comment is skipped", async () => {
    expect(await parse(": open\n\n: ping\ndata: 1\n: ping\n\n")).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("a field without a colon has an empty value", async () => {
    expect(await parse("data\n\n")).toStrictEqual([
      { data: undefined, text: "" },
    ]);
  });

  test("the name, the id and the retry are the event's own", async () => {
    expect(
      await parse(
        "event: tick\nid: 7\nretry: 3000\ndata: 1\n\nevent: a\nevent: b\ndata: 2\n\ndata: 3\n\n",
      ),
    ).toStrictEqual([
      { data: 1, text: "1", event: "tick", id: "7", retry: 3000 },
      { data: 2, text: "2", event: "b" },
      { data: 3, text: "3" },
    ]);
  });

  test("an empty name is no name", async () => {
    expect(await parse("event: a\nevent:\ndata: 1\n\n")).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("an empty id is an id", async () => {
    expect(await parse("id:\ndata: 1\n\n")).toStrictEqual([
      { data: 1, text: "1", id: "" },
    ]);
  });

  test("an id with NUL in it is ignored", async () => {
    expect(await parse("id: a\0b\ndata: 1\n\n")).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("a retry of anything but digits is ignored", async () => {
    expect(
      await parse(
        "retry: 3s\ndata: 1\n\nretry: -1\ndata: 2\n\nretry:\ndata: 3\n\nretry: 1.5\ndata: 4\n\n",
      ),
    ).toStrictEqual([
      { data: 1, text: "1" },
      { data: 2, text: "2" },
      { data: 3, text: "3" },
      { data: 4, text: "4" },
    ]);
  });

  test("an unknown field is ignored", async () => {
    expect(await parse("foo: bar\ndata: 1\n\n")).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("a block without data is no event, and what it set does not carry over", async () => {
    expect(
      await parse("event: lost\nid: 1\nretry: 5\n\ndata: 1\n\n"),
    ).toStrictEqual([{ data: 1, text: "1" }]);
  });

  test("an event the stream ends in the middle of is dropped", async () => {
    expect(await parse("data: 1\n\ndata: 2\n")).toStrictEqual([
      { data: 1, text: "1" },
    ]);

    expect(await parse("data: 1\n\ndata: 2")).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("a byte order mark is dropped at the start of the stream and nowhere else", async () => {
    expect(await parse("﻿data: 1\n\n﻿data: 2\n\ndata: 3\n\n")).toStrictEqual([
      { data: 1, text: "1" },
      { data: 3, text: "3" },
    ]);
  });
});

describe("the chunks", () => {
  const stream =
    '﻿: open\r\n\r\nevent: tick\r\nid: 1\r\ndata: {"a":"ф"}\r\ndata: 😀\r\n\r\ndata: b\r\rdata:  42\n\n';

  const expected = [
    {
      data: undefined,
      text: '{"a":"ф"}\n😀',
      event: "tick",
      id: "1",
    },
    { data: undefined, text: "b" },
    { data: 42, text: " 42" },
  ];

  test("cut at every byte, the stream reads as it does whole", async () => {
    const bytes = encoder.encode(stream);
    const cut = [...bytes].map((byte) => Uint8Array.of(byte));

    expect(await parse(stream)).toStrictEqual(expected);
    expect(await all(chunked(cut))).toStrictEqual(expected);
  });

  test("a CR and the LF after it in the next chunk end one line, an empty chunk between them", async () => {
    expect(
      await all(
        chunked([
          "data: a\r",
          "\ndata: b\r",
          new Uint8Array(0),
          "\ndata: c\r",
          "\n\r",
          "\n",
        ]),
      ),
    ).toStrictEqual([{ data: undefined, text: "a\nb\nc" }]);
  });

  test("a character cut between chunks is read whole", async () => {
    const bytes = encoder.encode("data: ф\n\n");

    expect(
      await all(chunked([bytes.subarray(0, 7), bytes.subarray(7)])),
    ).toStrictEqual([{ data: undefined, text: "ф" }]);
  });

  test("an event that ends in CR is given before the next chunk comes", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(opened) {
        controller = opened;
      },
    });

    controller.enqueue(encoder.encode("data: 1\r\r"));

    const iterator = events(new Response(body))[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toStrictEqual({
      data: 1,
      text: "1",
    });

    controller.close();

    expect((await iterator.next()).done).toBe(true);
  });
});

describe("the body", () => {
  test("is read only when the events are", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const read = events(new Response(body));

    await Bun.sleep(5);
    expect(pulled).toBe(false);

    expect(await Array.fromAsync(read)).toEqual([]);
    expect(pulled).toBe(true);
  });

  test("leaving the loop cancels it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: 1\n\ndata: 2\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const event of events(new Response(body))) {
      expect(event.data).toBe(1);
      break;
    }

    expect(cancelled).toBe(true);
  });

  test("is read once: a second loop throws", async () => {
    const read = events(chunked(["data: 1\n\n"]));

    expect(await Array.fromAsync(read)).toHaveLength(1);
    await expect(Array.fromAsync(read)).rejects.toThrow(/read once/);
  });

  test("a response without one throws rather than read as no events", async () => {
    await expect(Array.fromAsync(events(new Response(null)))).rejects.toThrow(
      /no body/,
    );
  });
});

const summaries = new Map<string, (summary: SseSummary) => void>();

/** The summary `sse()` gives when the stream of request `id` is over. */
const ended = (id: string): Promise<SseSummary> =>
  new Promise((resolve) => summaries.set(id, resolve));

const opened = new Map<string, () => void>();

/** Lets the stream of request `id` go on past its first event. */
const release = (id: string): void => opened.get(id)?.();

const stream = { 200: { contentType: "text/event-stream" } } as const;

const app = createApp({
  routes: {
    run: route({
      method: "POST",
      path: "/agents/:name/stream",
      bodyType: "json",
      schema: { response: stream },
      handler: (ctx) => {
        if (ctx.params.name !== "chat") {
          throw httpError(404, "AGENT_NOT_FOUND", "No such agent");
        }

        return sse(
          ctx,
          async function* () {
            yield {
              event: "start",
              id: 1,
              data: {
                body: ctx.body,
                authorization: ctx.req.headers.get("authorization"),
              },
            };

            yield { data: "line one\nline two" };
            yield { data: " 42" };
            yield { data: "hello" };
          },
          { heartbeatMs: 0 },
        );
      },
    }),
    held: route({
      method: "GET",
      path: "/held/:id",
      schema: { response: stream },
      handler: (ctx) => {
        const { id } = ctx.params;

        return sse(
          ctx,
          async function* (signal) {
            yield { data: "first" };

            await new Promise<void>((resolve) => {
              opened.set(id, resolve);
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });

            for (let index = 0; !signal.aborted; index += 1) {
              yield { data: index };
              await Bun.sleep(5);
            }
          },
          {
            heartbeatMs: 10,
            onEnd: (summary) => summaries.get(id)?.(summary),
          },
        );
      },
    }),
    counted: route({
      method: "GET",
      path: "/counted",
      schema: {
        response: {
          200: {
            contentType: "text/event-stream",
            body: z.object({ n: z.number(), at: z.date() }),
          },
        },
      },
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            yield { data: { n: 1, at: new Date(0) } };
            yield { data: { n: 2, at: new Date(1) } };
          },
          { heartbeatMs: 0 },
        ),
    }),
    json: route({
      method: "GET",
      path: "/json",
      handler: () => ({ ok: true }),
    }),
  },
});

const request = serve(app);

const api = createClient<typeof app>({ baseUrl: request.url });

/** The result of a call, which has to be a success. */
function succeeded<R extends { readonly ok: boolean }>(
  res: R,
): Extract<R, { readonly ok: true }> {
  if (!res.ok) {
    throw new Error("The call failed");
  }

  return res as Extract<R, { readonly ok: true }>;
}

describe("res.events against sse()", () => {
  test("a POST with a body and a header streams its events", async () => {
    const res = succeeded(
      await api.post("/agents/:name/stream", {
        params: { name: "chat" },
        body: { input: "Hello" },
        headers: { authorization: "Bearer t" },
      }),
    );

    expect(res.response.headers.get("content-type")).toStartWith(
      "text/event-stream",
    );

    expect(await Array.fromAsync(res.events)).toStrictEqual([
      {
        data: { body: { input: "Hello" }, authorization: "Bearer t" },
        text: '{"body":{"input":"Hello"},"authorization":"Bearer t"}',
        event: "start",
        id: "1",
      },
      { data: undefined, text: "line one\nline two" },
      { data: 42, text: " 42" },
      { data: undefined, text: "hello" },
    ]);
  });

  test("the data of an event has the type of the body the route declares", async () => {
    const res = succeeded(await api.get("/counted"));
    const read: { n: number; at: string }[] = [];

    for await (const event of res.events) {
      read.push(event.data);
    }

    expect(read).toStrictEqual([
      { n: 1, at: "1970-01-01T00:00:00.000Z" },
      { n: 2, at: "1970-01-01T00:00:00.001Z" },
    ]);
  });

  test("a failure before the stream is a result without events", async () => {
    const res = await api.post("/agents/:name/stream", {
      params: { name: "nobody" },
      body: {},
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res).not.toHaveProperty("events");
  });

  test("a JSON success has no events", async () => {
    expect(await api.get("/json")).not.toHaveProperty("events");
  });

  test("the first event comes while the stream is still open, and heartbeats are skipped", async () => {
    const id = "open";
    const done = ended(id);
    const res = succeeded(await api.get("/held/:id", { params: { id } }));
    const read: unknown[] = [];

    for await (const event of res.events) {
      read.push(event.data);

      if (read.length === 1) {
        await Bun.sleep(30);
        release(id);
      }

      if (read.length === 4) {
        break;
      }
    }

    expect(read).toEqual([undefined, 0, 1, 2]);
    expect((await done).reason).toBe("cancelled");
  });

  test("leaving the loop ends the stream on the server", async () => {
    const id = "break";
    const done = ended(id);
    const res = succeeded(await api.get("/held/:id", { params: { id } }));

    for await (const event of res.events) {
      expect(event.text).toBe("first");
      break;
    }

    expect((await done).reason).toBe("cancelled");
  });

  test("the request's signal aborts a loop waiting for an event, and ends the stream on the server", async () => {
    const id = "signal";
    const done = ended(id);
    const controller = new AbortController();
    const res = succeeded(
      await api.get("/held/:id", {
        params: { id },
        init: { signal: controller.signal },
      }),
    );

    const reading = (async () => {
      for await (const _ of res.events) {
        setTimeout(() => controller.abort(), 20);
      }
    })();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect((await done).reason).toBe("cancelled");
  });
});

describe("unwrap() of a stream", () => {
  test("throws, pointing at res.events, and ends the stream on the server", async () => {
    const id = "unwrap";
    const done = ended(id);
    const res = await api.get("/held/:id", { params: { id } });

    expect(() => unwrap(res)).toThrow(
      new TypeError(
        "A text/event-stream has no data to unwrap: read res.events (https://tetsujs.com/docs/packages/client/#streams)",
      ),
    );
    expect((await done).reason).toBe("cancelled");
  });

  test("throws for a stream already read from too", async () => {
    const res = succeeded(
      await api.get("/held/:id", { params: { id: "read" } }),
    );

    for await (const event of res.events) {
      expect(event.text).toBe("first");
      break;
    }

    expect(() => unwrap(res)).toThrow(TypeError);
  });
});

interface Faked {
  readonly "GET /feed": {
    readonly request: Record<never, never>;
    readonly responses: {
      readonly 200: Raw<"Text/Event-Stream; charset=utf-8">;
      readonly 500: undefined;
    };
  };
}

/** A client whose every call is answered with `status` and `type`. */
const faked = (status: number, type: string) =>
  createClient<Faked>({
    fetch: async () =>
      new Response("data: 1\n\n", {
        status,
        headers: { "content-type": type },
      }),
  });

describe("which result has events", () => {
  test("a success of an event stream, whatever the case and the parameters of its type", async () => {
    const res = succeeded(
      await faked(200, "Text/Event-Stream; charset=utf-8").get("/feed"),
    );

    expect(await Array.fromAsync(res.events)).toStrictEqual([
      { data: 1, text: "1" },
    ]);
  });

  test("not a failure, though it streams", async () => {
    expect(
      await faked(500, "text/event-stream").get("/feed"),
    ).not.toHaveProperty("events");
  });
});
