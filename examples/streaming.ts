/**
 * Responses that arrive over time: server-sent events and a CSV export.
 *
 * `sse()` and `stream()` take an async generator and handle what a loop
 * written by hand gets wrong: backpressure, stopping when the client
 * leaves — through the `signal` the generator is given — and ending the
 * generator. `sse()` frames events for `EventSource`; `stream()` leaves the
 * format to you.
 *
 * ```sh
 * bun examples/streaming.ts
 * curl -N localhost:3000/clock                   # an event a second
 * curl localhost:3000/export.csv
 * ```
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { sse, stream } from "@tetsujs/sse";

const rows = Array.from({ length: 1_000 }, (_, index) => ({
  id: index + 1,
  total: (index * 7.5).toFixed(2),
}));

class FeedsController {
  clock = route({
    method: "GET",
    path: "/clock",
    handler: (ctx) =>
      sse(ctx, async function* (signal) {
        while (!signal.aborted) {
          yield { event: "tick", data: { at: new Date().toISOString() } };
          await Bun.sleep(1_000);
        }
      }),
  });

  export = route({
    method: "GET",
    path: "/export.csv",
    handler: (ctx) =>
      stream(
        ctx,
        async function* () {
          yield "id,total\n";

          for (const row of rows) {
            yield `${row.id},${row.total}\n`;
          }
        },
        { contentType: "text/csv" },
      ),
  });
}

export default createApp({ routes: new FeedsController() });
