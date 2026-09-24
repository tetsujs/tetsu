# Examples

Each recipe is one file about one thing, and runs as it is:

```bash
bun install
bun examples/hello.ts
```

A recipe exports its application; Bun serves a default export that has a
`fetch`, on port 3000 or `PORT`. The `curl` lines to try are at the top of
each file.

| Recipe | What it shows |
| --- | --- |
| [`hello.ts`](hello.ts) | a controller, a route, `createApp` — the whole shape |
| [`validation.ts`](validation.ts) | `params`, `query` and `body` with Zod; what a `422` looks like |
| [`responses.ts`](responses.ts) | a status map as the route's contract; `201`, `204`, `404`; a field the schema keeps out of the JSON |
| [`hooks.ts`](hooks.ts) | a hook that authenticates and adds `user`; one that declares what it needs with `Requires`; an observer; mapping a domain error |
| [`groups.ts`](groups.ts) | prefixes, a guarded zone, hook packages mounted whole — CORS, request id, access log, security headers — and a rate limit on one route |
| [`cookies.ts`](cookies.ts) | a session in a signed cookie, read through `schema.cookies` |
| [`uploads.ts`](uploads.ts) | a form with a file, size and type checked by the schema |
| [`websocket.ts`](websocket.ts) | a chat room: a guarded handshake, typed frames, Bun's pub/sub |
| [`streaming.ts`](streaming.ts) | server-sent events and a CSV export from async generators |
| [`openapi.ts`](openapi.ts) | the OpenAPI document and its page, from the routes as they are |
| [`validators.ts`](validators.ts) | the same body with Zod, ArkType, Valibot and TypeBox |
| [`todos.ts`](todos.ts) + [`todos.test.ts`](todos.test.ts) | testing a controller: a handler called directly, then the app over HTTP |
| [`shutdown.ts`](shutdown.ts) | stopping on a signal without cutting the requests in flight |

And one application, to show how the pieces sit in a project:

| [`app/`](app) | |
| --- | --- |
| [`main.ts`](app/main.ts) | opens the database, serves, closes the database on shutdown |
| [`app.ts`](app/app.ts) | the composition root: every instance built once and handed to what needs it |
| [`auth.ts`](app/auth.ts) | the sessions service, and the hook built from it that says who is asking |
| [`notes/routes.ts`](app/notes/routes.ts) | the controller: its routes, and the hook it builds from the sessions it is given |
| [`notes/store.ts`](app/notes/store.ts) | notes in SQLite, through `bun:sqlite` |
| [`notes/schemas.ts`](app/notes/schemas.ts) | the shapes in and out |
| [`notes/routes.test.ts`](app/notes/routes.test.ts) | the API over HTTP, on a database in memory |

```bash
bun examples/app/main.ts
```

Files are named for what they hold, not for a role: `notes/routes.ts`, not
`notes.controller.ts`. The framework reads the routes of the controllers it
is given and nothing else, so how files are laid out is entirely yours.

`bun test examples` runs the tests here, including `recipes.test.ts`, which
serves every recipe and asks it one question — an example that stops
working fails there first.
