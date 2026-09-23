/**
 * Type-level assertion helpers for `*.test-d.ts` files.
 *
 * These files are never executed; assertions are verified by `tsc --noEmit`.
 *
 * @module
 */

/**
 * Resolves to `true` only when `X` and `Y` are exactly the same type.
 *
 * Stricter than `X extends Y`: distinguishes `any`, `unknown` and `never`,
 * and does not tolerate one-directional assignability.
 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/**
 * Fails to compile unless `T` is exactly `true`.
 *
 * @example
 * ```ts
 * export type cases = [Expect<Equal<InferOutput<typeof User>, { id: string }>>];
 * ```
 */
export type Expect<T extends true> = T;
