/**
 * What a refusal costs, thrown against returned.
 *
 * The framework's design notes and its hook-package canon both rest on
 * one number: a hook
 * that refuses in bulk — a rate limiter — returns a `Response` instead of
 * throwing an `HttpError`. The number used to be "roughly 2.6×, because a
 * throw captures a stack", measured once during the first review with no
 * harness left behind. A number that decides an API and cannot be re-run
 * was the one place this repository's benchmarks were not honest.
 *
 * Running it settled two things: the ratio is larger than claimed —
 * 3.1–3.2× through the pipeline — and the stated reason was wrong.
 * Constructing an `HttpError` is a few percent *cheaper* than constructing
 * a `Response`, so the captured stack is not the cost. The numbers are in
 * `bench/README.md`.
 *
 * Two questions, and the ladder answers them separately:
 *
 * - **Where does the cost come from?** Building the `Error` is not free
 *   even if nobody throws it: the constructor captures a stack. The rungs
 *   split construction from unwinding so the two are not confused.
 * - **What does a request actually pay?** The last two rungs run the real
 *   compiled path handler on a route whose `beforeParse` hook refuses —
 *   once by returning, once by throwing. Their ratio is the number the
 *   decision stands on, and the one the design notes should carry.
 *
 * The end-to-end rungs are the honest comparison because the two paths are
 * not the same length: a returned `Response` short-circuits to
 * `beforeResponse`, while a thrown one unwinds into `recover`, through
 * `onError` mapping, and only then finalizes.
 *
 * Run: `bun run --cwd bench refusal`
 *
 * @module
 */

import { createApp, errorBody, HttpError, hook, route } from "@tetsujs/core";
import { bench, run, summary } from "mitata";

const status = 429;

const body = { ...errorBody(status, "RATE_LIMITED"), retryAfter: 30 };

const returning = hook.beforeParse(() => Response.json(body, { status }));

const throwing = hook.beforeParse(() => {
  throw new HttpError(status, body);
});

/** One app per refusal style, identical but for the hook. */
function appRefusing(guard: typeof returning | typeof throwing) {
  const app = createApp({
    routes: {
      limited: route({
        method: "GET",
        path: "/limited",
        hooks: { beforeParse: [guard] },
        handler: () => ({ unreachable: true }),
      }),
    },
  });

  const pathHandler = app.routes["/limited"];

  if (!pathHandler) {
    throw new Error("bench: the /limited route is gone");
  }

  return pathHandler;
}

const returnPath = appRefusing(returning);

const throwPath = appRefusing(throwing);

const server = {} as never;

/**
 * One request, reused — allocating a `Request` costs more than the whole
 * quantity being measured here, the same reason `cost.ts` reuses one.
 */
const req = Object.defineProperty(
  new Request("http://bench/limited"),
  "params",
  {
    value: {},
  },
) as never;

summary(() => {
  bench("build a Response", () => Response.json(body, { status }));
  bench(
    "build an HttpError (stack captured, never thrown)",
    () => new HttpError(status, body),
  );
  bench("throw and catch an HttpError", () => {
    try {
      throw new HttpError(status, body);
    } catch (error) {
      return error;
    }
  });
});

summary(() => {
  bench(
    "refuse by returning, through the pipeline",
    async () => await returnPath(req, server),
  );
  bench(
    "refuse by throwing, through the pipeline",
    async () => await throwPath(req, server),
  );
});

await run();
