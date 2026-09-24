/**
 * Who is asking: a bearer token, looked up by a service the application
 * wires like any other.
 *
 * A real application verifies a JWT or a session in the service; what
 * matters to the routes is only that the hook refuses with `401` or
 * contributes `user`. The hook is a factory over the service, the way a
 * hook package is a factory over its options, so the controller that
 * mounts it builds it from what it was given. Wrapped in `secured()` so the
 * OpenAPI document knows what it enforces.
 *
 * @module
 */

import { HttpError, hook } from "@tetsujs/core";
import { secured } from "@tetsujs/openapi";

export interface User {
  readonly id: string;
}

/** Knows which tokens belong to whom. */
export class Sessions {
  constructor(private readonly tokens: ReadonlyMap<string, User>) {}

  find(token: string): User | undefined {
    return this.tokens.get(token);
  }
}

/** The tokens the example knows, for `main.ts` and the tests. */
export const demoTokens: ReadonlyMap<string, User> = new Map([
  ["ada-token", { id: "ada" }],
  ["grace-token", { id: "grace" }],
]);

/** A hook that refuses an unknown token and contributes `user`. */
export const authenticate = (sessions: Sessions) =>
  secured(
    hook.beforeParse((ctx) => {
      const header = ctx.req.headers.get("authorization") ?? "";
      const user = sessions.find(header.replace(/^Bearer /, ""));

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
