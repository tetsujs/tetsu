/**
 * Shared schema mock for `*.test-d.ts` files.
 *
 * Declared only — never implemented or executed; type tests import it purely
 * for inference.
 *
 * @module
 */

import type { StandardSchemaV1 } from "../src/schema.ts";

export declare function mockSchema<Output, Input = unknown>(): StandardSchemaV1<
  Input,
  Output
>;
