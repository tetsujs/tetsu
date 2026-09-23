/**
 * Internal utilities shared across core modules.
 *
 * Nothing in this module is part of the public API or re-exported from the
 * package entry point.
 *
 * @module
 */

/**
 * Flattens intersections into a single object type so editor hints show
 * `{ a: string; b: number }` instead of `{ a: string } & { b: number }`.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Tells whether a value must be awaited.
 *
 * Deliberately not `instanceof Promise`: lazy thenables (the pattern used by
 * query builders such as Prisma) are awaitable without being Promise
 * instances, and missing them silently drops results or skips validation.
 * Synchronous values still avoid the microtask.
 */
export function isThenable<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}
