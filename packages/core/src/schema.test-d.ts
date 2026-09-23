/**
 * Type-level tests for the vendored Standard Schema definitions.
 *
 * Never executed — checked by `tsc --noEmit` only. The `test-d` suffix keeps
 * the file out of `bun test` discovery.
 *
 * @module
 */

import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { InferInput, InferOutput } from "./schema.ts";

const User = mockSchema<{ id: string; name: string }>();

const Coerced = mockSchema<number, string>();

export type cases = [
  Expect<Equal<InferOutput<typeof User>, { id: string; name: string }>>,
  Expect<Equal<InferInput<typeof User>, unknown>>,
  Expect<Equal<InferOutput<typeof Coerced>, number>>,
  Expect<Equal<InferInput<typeof Coerced>, string>>,
];
