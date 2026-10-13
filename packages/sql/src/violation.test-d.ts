/**
 * The names `isViolation()` takes: those the generated files register,
 * here the fixture's, and no other.
 *
 * @module
 */

import { SQL } from "bun";
import type { Constraint } from "../test-utils/fixtures/schema/db.generated.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { ConstraintName } from "./violation.ts";
import { isViolation } from "./violation.ts";

declare const error: unknown;

export type names = [Expect<Equal<ConstraintName, Constraint>>];

export const told = isViolation(error, "orders_email_key");

// @ts-expect-error a name no generated file holds is refused
export const mistyped = isViolation(error, "orders_emial_key");

export function narrowed(): "orders_email_key" | undefined {
  if (isViolation(error, "orders_email_key")) {
    return error.constraint;
  }

  return undefined;
}

export function answered(caught: unknown): string {
  if (!(caught instanceof SQL.PostgresError)) {
    throw caught;
  }

  if (isViolation(caught, "orders_email_key")) {
    return "taken";
  }

  return caught.message;
}
