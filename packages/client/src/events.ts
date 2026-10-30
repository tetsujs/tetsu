/**
 * The events of a `text/event-stream` response, read as the WHATWG HTML
 * standard parses an event stream — what a browser's `EventSource` does,
 * without its reconnecting, for a request it cannot make: a `POST` with a
 * body, a header of the caller's own.
 *
 * @module
 */

import type { ReceivedEvent } from "./types.ts";

/**
 * The events of `response`, read from its body as they are iterated — and
 * only then. Leaving the loop — `break`, `return`, a throw — cancels the
 * body, which closes the connection; the request's signal aborts the
 * read. The body is read once: a second loop throws, as does a response
 * without a body to read, from a `fetch` that does not stream.
 */
export function events(response: Response): AsyncIterable<ReceivedEvent> {
  let taken = false;

  return {
    [Symbol.asyncIterator]() {
      if (taken) {
        throw new TypeError("The events of a response can be read once");
      }

      taken = true;

      return read(response.body);
    },
  };
}

/**
 * The events of a body: its lines, a blank one ending each event. A block
 * without data is no event, and what it set does not carry over.
 */
async function* read(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<ReceivedEvent, void, undefined> {
  let data: string[] = [];
  let fields: { event?: string; id?: string; retry?: number } = {};

  for await (const line of lines(body)) {
    if (line === "") {
      if (data.length > 0) {
        const text = data.join("\n");

        yield { data: json(text), text, ...fields };
      }

      data = [];
      fields = {};

      continue;
    }

    const colon = line.indexOf(":");

    if (colon === 0) {
      continue;
    }

    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);

    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      if (value === "") {
        delete fields.event;
      } else {
        fields.event = value;
      }
    } else if (field === "id" && !value.includes("\0")) {
      fields.id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      fields.retry = Number(value);
    }
  }
}

/**
 * The lines of a body, decoded as UTF-8 and split at CRLF, LF or CR — a
 * line that ends in CR is given at once, and an LF that opens the next
 * chunk is the rest of its CRLF. What is left of the last chunk has no
 * line break, so a chunk is searched from where it starts: a long line
 * that comes in many chunks is not searched again for each. Leaving the
 * loop cancels the body.
 */
async function* lines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string, void, undefined> {
  if (!body) {
    throw new TypeError("The response has no body to read events from");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let afterCr = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      const scanned = buffer.length;

      buffer += decoder.decode(value, { stream: true });

      if (afterCr && buffer !== "") {
        afterCr = false;

        if (buffer.startsWith("\n")) {
          buffer = buffer.slice(1);
        }
      }

      let start = 0;

      for (;;) {
        const end = lineEnd(buffer, Math.max(start, scanned));

        if (end === -1) {
          break;
        }

        yield buffer.slice(start, end);

        start = end + 1;

        if (buffer[end] === "\r") {
          if (start === buffer.length) {
            afterCr = true;
          } else if (buffer[start] === "\n") {
            start += 1;
          }
        }
      }

      buffer = buffer.slice(start);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Where the line starting at `start` ends: its CR or LF, or `-1`. */
function lineEnd(buffer: string, start: number): number {
  for (let index = start; index < buffer.length; index += 1) {
    const char = buffer[index];

    if (char === "\n" || char === "\r") {
      return index;
    }
  }

  return -1;
}

/** `text` as JSON, or `undefined` when it is not. */
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
