---
title: Introduction
description: Tetsu is an HTTP framework for Bun with controllers, lifecycle hooks in fixed slots and types inferred from end to end.
---

Tetsu is an HTTP framework for Bun. You declare controllers with the
dependencies they need, put hooks in the fixed slots of a request instead of
a middleware chain, and let the compiler infer every type from the path to
the handler — without decorators, a DI container or dependencies in the core.

```ts twoslash
interface User { id: number; name: string }
interface UserRepository { find(id: number): User | undefined }
declare const repo: UserRepository;
// ---cut---
import { controller, createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const users = controller("Users", ({ repo }: { repo: UserRepository }) => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const user = repo.find(ctx.params.id);
      //                            ^?
      if (!user) throw httpError(404, "USER_NOT_FOUND");
      return user;
    },
  }),
}));

Bun.serve({ ...createApp({ routes: users({ repo }) }) });
```

Nothing in that example is annotated. `ctx.params.id` is a number because
the schema turns the path segment into one, and it would not exist at all
without `:id` in the path. The request is checked before the handler runs; a
bad id is answered with `422` and the handler never sees it.

## What it is built on

- **Controllers without decorators.** A controller is a name and a function
  from its dependencies to its routes. The application is wired by hand, in
  one place, with ordinary code.
- **Hooks in fixed slots.** A request passes through named stages —
  `beforeParse`, `parse`, `beforeValidation`, `validate`, `beforeHandle`,
  the handler, `beforeResponse`, `afterResponse` — plus `onError`. A hook
  says which slot it belongs to, and what it returns joins `ctx`, typed in
  everything that runs after it.
- **Types that do not lie.** A field is on `ctx` exactly when it exists at
  that point of the request. The compiler checks the order of hooks, what
  each one needs and what it adds.
- **The platform, not a wrapper.** Routing is Bun's native router,
  `ctx.out.headers` is a `Headers`, cookies are Bun's `CookieMap`,
  `ctx.server` is the real server. Validation goes through
  [Standard Schema](https://standardschema.dev), so you bring Zod, Valibot,
  ArkType or TypeBox.

## What it is not

Tetsu runs on Bun only: it uses Bun's router and server rather than
abstracting them. It has no plugin system — a package is a function that
returns one hook, mounted in its slot like any other. It has no container,
no file-based routing and no global registry; everything that runs for a
route is visible where the route is declared.

## Where to go next

- [Installation](/docs/installation/) — Bun, TypeScript and the settings the
  types need.
- [Quick start](/docs/quick-start/) — a first application, from an empty
  folder to a tested endpoint.
- [Key concepts](/docs/key-concepts/) — the whole model on one page.
