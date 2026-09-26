/**
 * Testing helpers, published as `@tetsujs/core/testing`.
 *
 * Two complementary halves of the testing story:
 *
 * - `serve()` — integration: serves an application on an ephemeral port the
 *   way production does, because Bun's native router is unreachable in
 *   process. It stops the server when the test file finishes.
 * - `testCtx()` — unit: builds a typed context for calling a route handler
 *   directly, with no server and no HTTP.
 *
 * Plus `captureErrors()`, for the paths where the framework reports on
 * `console.error` what it cannot report to the client: a suite that prints
 * expected errors is a suite where an unexpected one goes unnoticed.
 *
 * @module
 */

export { testCtx } from "./ctx.ts";
export type { CapturedErrors } from "./logs.ts";
export { captureErrors } from "./logs.ts";
export type { RequestFn, ServeOptions } from "./server.ts";
export { serve, stopServers } from "./server.ts";
