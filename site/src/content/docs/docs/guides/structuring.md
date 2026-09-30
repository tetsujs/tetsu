---
title: Structuring an application
description: A simple layout to start from. Tetsu does not care where files live, so change it as the application asks.
sidebar:
  order: 1
---

Tetsu reads the routes it is given, not files or folders, so any layout
works. Here is a simple one to start from; change it when the application
asks for something else.

```text
src/
  main.ts              starts the server
  app.ts               builds the application
  notes/
    controller.ts      the routes
    service.ts         the logic and the queries
    schemas.ts         what comes in and what goes out
    controller.test.ts
```

Two habits are worth keeping whatever the layout.

## Build the application in a function

`app.ts` makes the services and returns the application:

```ts twoslash title="src/app.ts"
// @filename: src/notes/service.ts
import type { Database } from "bun:sqlite";
export class NoteService {
  constructor(private readonly db: Database) {}
  list(): { id: number; text: string }[] { return []; }
}
// @filename: src/notes/controller.ts
import { controller, route } from "@tetsujs/core";
import type { NoteService } from "./service";
export const notesController = controller("Notes", (notes: NoteService) => ({
  list: route({ method: "GET", path: "/notes", handler: () => notes.list() }),
}));
// @filename: src/app.ts
// ---cut---
import type { Database } from "bun:sqlite";
import { createApp } from "@tetsujs/core";
import { notesController } from "./notes/controller";
import { NoteService } from "./notes/service";

export function buildApp(db: Database) {
  const notes = new NoteService(db);

  return createApp({ routes: notesController(notes) });
}
```

`main.ts` only serves it, and a test builds the same application from a
database in memory — so the test runs what the server runs:

```ts twoslash title="src/main.ts"
// @filename: src/app.ts
import type { Database } from "bun:sqlite";
import { createApp } from "@tetsujs/core";
export function buildApp(db: Database) { return createApp({ routes: [] }); }
// @filename: src/main.ts
// ---cut---
import { Database } from "bun:sqlite";
import { buildApp } from "./app";

Bun.serve({ ...buildApp(new Database("notes.sqlite")), port: 3000 });
```

```ts twoslash title="src/notes/controller.test.ts"
// @filename: src/app.ts
import type { Database } from "bun:sqlite";
import { controller, createApp, route } from "@tetsujs/core";
const notes = controller("Notes", () => ({ list: route({ method: "GET", path: "/notes", handler: () => [] }) }));
export function buildApp(db: Database) { return createApp({ routes: notes() }); }
// @filename: src/notes/controller.test.ts
// ---cut---
import { Database } from "bun:sqlite";
import { serve } from "@tetsujs/core/testing";
import { expect, test } from "bun:test";
import { buildApp } from "../app";

const request = serve(buildApp(new Database(":memory:")));

test("lists notes", async () => {
  expect((await request("/notes")).status).toBe(200);
});
```

## Keep HTTP out of services

A service takes values, returns values and throws errors of its own; routes
and hooks deal with requests. Then a service is tested without a server,
and anything else — a scheduled job, a script — can use it too.

Everything beyond that is yours to decide. A small runnable application
laid out this way is
[`examples/app`](https://github.com/tetsujs/tetsu/blob/main/examples/app).
