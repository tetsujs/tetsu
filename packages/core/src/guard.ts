/**
 * The context fields the pipeline owns, and the two operations that
 * respect them.
 *
 * A hook extends the context by returning an object, and a socket carries
 * a copy of the context it was opened with. Both walk the same key set and
 * both must leave the pipeline's own fields alone — so both live here,
 * next to the list that says which those are.
 *
 * Internal to the core.
 *
 * @module
 */

import type { PipelineCtx } from "./pipeline.ts";

/**
 * Keys a hook's return value can never contribute to the context.
 *
 * `__proto__` and friends are prototype-pollution vectors that arrive for
 * free in request bodies — `JSON.parse` makes `__proto__` an own property
 * and object spread preserves it, so a hook normalizing the body by
 * spreading it would otherwise re-point the context's prototype at
 * attacker-supplied data. `req`, `server`, `out`, `route`, `res` and
 * `error` are owned by the pipeline; replacing them breaks stages
 * downstream — a forged `server` in particular would defeat every
 * `requestIP`-based rate limit behind it, and a forged `route` would let a
 * hook rename the endpoint in every log line and metric that trusts it.
 *
 * `params`, `query`, `body`, `headers` and `cookies` are deliberately
 * absent: hooks are expected to normalize those.
 *
 * Invariant: every field of `PipelineCtx` except those five data fields
 * must be listed here. Adding a field to `PipelineCtx` means adding it to
 * this set in the same change — and to its type-level mirror,
 * `PipelineOwnedKey` in hook.ts.
 */
const protectedKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "req",
  "server",
  "out",
  "route",
  "res",
  "error",
]);

/**
 * Merges a hook's returned extension into the context by mutation.
 *
 * @param ctx - The context to extend, in place.
 * @param extension - What the hook returned.
 */
export function extendContext(ctx: PipelineCtx, extension: object): void {
  copyContributed(
    extension as Record<string, unknown>,
    ctx as unknown as Record<string, unknown>,
  );
}

/**
 * Copies the data fields of a context, leaving the pipeline's own behind.
 *
 * What a socket carries as its `data`: path parameters, validated parts
 * and everything the handshake's hooks contributed — but not `req`, `out`
 * or `server`, which belong to the request rather than to the connection
 * that outlives it.
 */
export function contextSnapshot(ctx: PipelineCtx): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};

  copyContributed(ctx as unknown as Record<string, unknown>, snapshot);

  return snapshot;
}

/**
 * Copies every key the pipeline does not own.
 *
 * Iterates `Object.keys`, not `Object.entries`: this runs for every
 * extending hook on every request, and `entries` allocates a pair array
 * per key on top of the keys array — measured at ~4× the cost for typical
 * extensions.
 */
function copyContributed(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    if (!protectedKeys.has(key)) {
      target[key] = source[key];
    }
  }
}
