/**
 * Declaring what a route answers with.
 *
 * A status map is the route's contract: the handler may return only the
 * shapes it declares and write only the statuses it lists, and every body
 * leaves through the schema of its status — which is what keeps
 * `passwordHash`, present on the stored user, out of the JSON. `null`
 * declares a status without a body.
 *
 * Errors are thrown, not returned: `httpError(404, …)` becomes the error
 * envelope `{ status, message, error }`.
 *
 * ```sh
 * bun examples/responses.ts
 * curl localhost:3000/users/1          # no passwordHash
 * curl localhost:3000/users/9          # 404 envelope
 * curl -X POST localhost:3000/users -H 'content-type: application/json' \
 *   -d '{"name":"Grace"}'              # 201
 * curl -X DELETE -i localhost:3000/users/1   # 204, no body
 * ```
 *
 * @module
 */

import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const UserId = z.object({ id: z.coerce.number().int().positive() });

const NewUser = z.object({ name: z.string().min(1) });

const PublicUser = z.object({ id: z.number(), name: z.string() });

interface StoredUser {
  readonly id: number;
  readonly name: string;
  readonly passwordHash: string;
}

class UsersController {
  private readonly users = new Map<number, StoredUser>([
    [1, { id: 1, name: "Ada", passwordHash: "$argon2id$…" }],
  ]);

  get = route({
    method: "GET",
    path: "/users/:id",
    schema: { params: UserId, response: { 200: PublicUser } },
    handler: (ctx) => {
      const user = this.users.get(ctx.params.id);

      if (!user) {
        throw httpError(404, "USER_NOT_FOUND");
      }

      return user;
    },
  });

  create = route({
    method: "POST",
    path: "/users",
    schema: { body: NewUser, response: { 201: PublicUser } },
    handler: (ctx) => {
      const user = {
        id: this.users.size + 1,
        name: ctx.body.name,
        passwordHash: "$argon2id$…",
      };

      this.users.set(user.id, user);
      ctx.out.status = 201;

      return user;
    },
  });

  remove = route({
    method: "DELETE",
    path: "/users/:id",
    schema: { params: UserId, response: { 204: null } },
    handler: (ctx) => {
      if (!this.users.delete(ctx.params.id)) {
        throw httpError(404, "USER_NOT_FOUND");
      }
    },
  });
}

export default createApp({ routes: new UsersController() });
