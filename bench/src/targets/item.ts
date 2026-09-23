/**
 * The request body the `POST /items` profile validates, as a hand-written
 * Standard Schema — the same checker for every target that takes Standard
 * Schema, so the profile compares frameworks rather than validators.
 * Elysia gets `t.Object`, its own compiled validator, because that is what
 * an Elysia application would write.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@tetsujs/core";

export interface Item {
  readonly name: string;
  readonly qty: number;
}

export const ItemSchema: StandardSchemaV1<unknown, Item> = {
  "~standard": {
    version: 1,
    vendor: "bench",
    validate: (value) => {
      const input = value as { name?: unknown; qty?: unknown } | null;

      return typeof input?.name === "string" && typeof input.qty === "number"
        ? { value: { name: input.name, qty: input.qty } }
        : { issues: [{ message: "invalid item" }] };
    },
  },
};
