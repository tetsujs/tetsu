---
title: Quick start
description: A first Tetsu application — a controller with three routes, validation, errors and a test — from an empty folder.
---

This page builds a small users API from an empty folder: three routes, a
validated body, an error of your own and a test. It needs only Bun.

## Create the project

```bash
mkdir users-api && cd users-api
bun init -y
bun add @tetsujs/core zod
```

`bun init` already sets up TypeScript the way Tetsu needs. To add Tetsu to an
existing project, see [Installation](/docs/installation/).

## Declare the routes

A controller is a name and a function from its dependencies to its routes.
Here a `Map` stands in for a database:

```ts twoslash title="src/users.ts"
import { controller, httpError, route } from "@tetsujs/core";
import { z } from "zod";

export interface User {
  id: number;
  name: string;
  email: string;
}

const NewUser = z.object({ name: z.string().min(1), email: z.email() });
const UserId = z.object({ id: z.coerce.number().int().positive() });

export const usersController = controller("Users", (users: Map<number, User>) => ({
  list: route({
    method: "GET",
    path: "/users",
    handler: () => [...users.values()],
  }),

  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: UserId },
    handler: (ctx) => {
      const user = users.get(ctx.params.id);
      if (!user) throw httpError(404, "USER_NOT_FOUND", "No such user");
      return user;
    },
  }),

  create: route({
    method: "POST",
    path: "/users",
    schema: { body: NewUser },
    handler: (ctx) => {
      const user = { id: users.size + 1, ...ctx.body };
      users.set(user.id, user);
      ctx.out.status = 201;
      return user;
    },
  }),
}));
```

- `ctx.params.id` is a number: the schema converts the `:id` segment before
  the handler runs, and `/users/abc` never reaches it.
- `ctx.body` exists only on `create`, the route with a body schema, and has
  the schema's type.
- `httpError(404, "USER_NOT_FOUND", …)` is your own error, in the same shape
  as the framework's.

## Serve it

`createApp` turns the routes into plain data that `Bun.serve` takes as it
is:

```ts twoslash title="index.ts"
// @filename: src/users.ts
import { controller, httpError, route } from "@tetsujs/core";
import { z } from "zod";

export interface User {
  id: number;
  name: string;
  email: string;
}

const NewUser = z.object({ name: z.string().min(1), email: z.email() });
const UserId = z.object({ id: z.coerce.number().int().positive() });

export const usersController = controller("Users", (users: Map<number, User>) => ({
  list: route({
    method: "GET",
    path: "/users",
    handler: () => [...users.values()],
  }),

  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: UserId },
    handler: (ctx) => {
      const user = users.get(ctx.params.id);
      if (!user) throw httpError(404, "USER_NOT_FOUND", "No such user");
      return user;
    },
  }),

  create: route({
    method: "POST",
    path: "/users",
    schema: { body: NewUser },
    handler: (ctx) => {
      const user = { id: users.size + 1, ...ctx.body };
      users.set(user.id, user);
      ctx.out.status = 201;
      return user;
    },
  }),
}));
// @filename: index.ts
// ---cut---
import { createApp } from "@tetsujs/core";
import type { User } from "./src/users";
import { usersController } from "./src/users";

const users = new Map<number, User>();

const app = createApp({ routes: usersController(users) });

Bun.serve({ ...app, port: 3000 });

console.log("Listening on http://localhost:3000");
```

```bash
bun --watch index.ts
```

## Try it

```bash
curl -X POST localhost:3000/users -d '{"name":"Ada","email":"ada@example.com"}'
```

```json
{ "id": 1, "name": "Ada", "email": "ada@example.com" }
```

The body is parsed as JSON, the route's default, whatever `content-type`
the client sends (curl's `-d` sends a form type). A request the schema
refuses gets a `422` with every issue at once:

```bash
curl -X POST localhost:3000/users -d '{"name":"","email":"nope"}'
```

```json
{
  "status": 422,
  "message": "Validation failed",
  "error": "VALIDATION_FAILED",
  "issues": [
    { "message": "Too small: expected string to have >=1 characters", "path": ["body", "name"] },
    { "message": "Invalid email address", "path": ["body", "email"] }
  ]
}
```

Your own error has the same shape:

```bash
curl localhost:3000/users/7
```

```json
{ "status": 404, "message": "No such user", "error": "USER_NOT_FOUND" }
```

## Test it

Routing is Bun's, and only a real socket reaches it. `serve()` from
`@tetsujs/core/testing` starts the application on a free port and stops it
when the test file finishes:

```ts twoslash title="src/users.test.ts"
// @filename: src/users.ts
import { controller, httpError, route } from "@tetsujs/core";
import { z } from "zod";

export interface User {
  id: number;
  name: string;
  email: string;
}

const NewUser = z.object({ name: z.string().min(1), email: z.email() });
const UserId = z.object({ id: z.coerce.number().int().positive() });

export const usersController = controller("Users", (users: Map<number, User>) => ({
  list: route({
    method: "GET",
    path: "/users",
    handler: () => [...users.values()],
  }),

  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: UserId },
    handler: (ctx) => {
      const user = users.get(ctx.params.id);
      if (!user) throw httpError(404, "USER_NOT_FOUND", "No such user");
      return user;
    },
  }),

  create: route({
    method: "POST",
    path: "/users",
    schema: { body: NewUser },
    handler: (ctx) => {
      const user = { id: users.size + 1, ...ctx.body };
      users.set(user.id, user);
      ctx.out.status = 201;
      return user;
    },
  }),
}));
// @filename: src/users.test.ts
// ---cut---
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { expect, test } from "bun:test";
import { usersController } from "./users";

const request = serve(createApp({ routes: usersController(new Map()) }));

test("creates a user and reads it back", async () => {
  const created = await request("/users", {
    method: "POST",
    body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
  });

  expect(created.status).toBe(201);
  expect(await (await request("/users/1")).json()).toEqual({
    id: 1,
    name: "Ada",
    email: "ada@example.com",
  });
});
```

```bash
bun test
```

## Where to go next

- [Key concepts](/docs/key-concepts/) — the whole model on one page.
- [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) — authentication,
  logging and whatever else runs around a handler.
- [Structuring an application](/docs/guides/structuring/) — where things go
  once there is more than one controller.
