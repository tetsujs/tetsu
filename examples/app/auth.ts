/**
 * Who is asking: a bearer token looked up in a table of known ones.
 *
 * A real application verifies a JWT or a session here; what matters to the
 * routes is only that the hook refuses with `401` or contributes `user`.
 * Wrapped in `secured()` so the OpenAPI document knows what it enforces.
 *
 * @module
 */

import { HttpError, hook } from "@tetsujs/core";
import { secured } from "@tetsujs/openapi";

export interface User {
  readonly id: string;
}

const tokens = new Map<string, User>([
  ["ada-token", { id: "ada" }],
  ["grace-token", { id: "grace" }],
]);

export const authenticate = secured(
  hook.beforeParse((ctx) => {
    const header = ctx.req.headers.get("authorization") ?? "";
    const user = tokens.get(header.replace(/^Bearer /, ""));

    if (!user) {
      throw new HttpError(401);
    }

    return { user };
  }),
  {
    name: "bearer",
    scheme: { type: "http", scheme: "bearer" },
    description: "Missing or unknown token",
    error: "UNAUTHORIZED",
  },
);
