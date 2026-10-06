/**
 * Tests for requests without a usable `Host`, sent as written: an HTTP/1.0
 * request without one, as a health check sends it, or one whose `Host`
 * makes no URL. Bun leaves `req.url` relative for the first and makes it
 * no URL at all for the second, so nothing on the way may parse it as one.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

/** The status and body of a request written exactly as given. */
function sentAsWritten(
  url: URL,
  request: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let received = "";

    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(request);
    });

    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("close", () => {
      const [head = "", body = ""] = received.split("\r\n\r\n");

      resolve({ status: Number(head.split(" ")[1]), body });
    });
    socket.on("error", reject);
  });
}

const Passthrough: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as Record<string, unknown> }),
  },
};

describe("the query of a request without a usable Host", () => {
  const request = serve(
    createApp({
      routes: [
        route({
          method: "GET",
          path: "/search",
          schema: { query: Passthrough },
          handler: (ctx) => ctx.query,
        }),
        route({
          method: "GET",
          path: "/files/:name",
          schema: { query: Passthrough },
          handler: (ctx) => ctx.query,
        }),
      ],
    }),
  );

  const expected = { tag: ["a b", "c d"], page: "2" };

  test("is read as it is with one, over HTTP/1.0 without a Host", async () => {
    const { status, body } = await sentAsWritten(
      request.url,
      "GET /search?tag=a%20b&tag=c+d&page=2 HTTP/1.0\r\n\r\n",
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual(expected);
  });

  test("is empty with a Host that makes no URL, rather than a 500", async () => {
    const { status, body } = await sentAsWritten(
      request.url,
      "GET /search?tag=a%20b&tag=c+d&page=2 HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({});
  });

  test("is the same with a Host", async () => {
    const res = await request("/search?tag=a%20b&tag=c+d&page=2");

    expect(await res.json()).toEqual(expected);
  });

  test("is read as the URL standard reads it, which a proxy reads it by", async () => {
    expect(await (await request("/search??role=admin")).json()).toEqual({
      "?role": "admin",
    });

    const { body } = await sentAsWritten(
      request.url,
      "GET /files/x#y?role=admin HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n",
    );

    expect(JSON.parse(body)).toEqual({});
  });
});
