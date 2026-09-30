---
title: Deploy to production
description: Serving the application with Bun.serve, configuration from the environment, graceful shutdown, a container image and a single-file binary.
sidebar:
  order: 4
---

This page takes an application from `bun src/main.ts` on a laptop to a
process in production: how it is served, where its configuration comes
from, how it stops, and two ways to ship it — a container image and a
single-file binary built by `bun build --compile`.

There is no production mode to switch on. The application runs the same
code in every environment, and what differs between them is passed in by
`main.ts`.

## Serving

`createApp` returns plain data — the routes, a fallback, a WebSocket
handler — and `Bun.serve` takes it as it is. Bun's own options go next to
it:

```ts twoslash
import { createApp } from "@tetsujs/core";
const app = createApp({ routes: [] });
// ---cut---
const server = Bun.serve({
  ...app,
  port: Number(Bun.env.PORT ?? 3000),
});

console.log(`listening on ${server.url}`);
```

There is no server object of the framework's own to configure. The port,
the address to listen on, TLS, Bun's idle timeout and its body cap are
options of `Bun.serve`, and an option written after the spread wins over
one the application carries.

Without a `hostname`, Bun listens on every interface, IPv4 and IPv6, which
is what a container needs: a server that listens on `localhost` only is
unreachable from outside it.

## Configuration

The core reads no environment variables. The port goes to `Bun.serve`, the
cookie secret to `createApp`, a limit to `rateLimit()`; `main.ts` reads the
environment once, checks it, and passes the values in. A missing secret
then stops the process at startup rather than on the first request that
needs it.

`NODE_ENV` does not change the framework's behaviour: errors have the same
shape, responses are checked the same way, and nothing is logged
differently. Where an application wants a difference, it says so in
`main.ts`, as a value:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
// ---cut---
createApp({
  validateResponses: Bun.env.NODE_ENV !== "production",
  routes,
});
```

Response checks are on by default, everywhere. Turning them off in
production saves their cost, and loses what they do besides checking: the
value a response schema returns is what gets serialized, so a schema that
strips unknown keys is what keeps a field like `passwordHash` out of the
JSON. Keep them on unless a measurement says otherwise.

## Stopping without cutting requests

A deploy, a scale-down or a restart sends the process `SIGTERM`. Stopping
at once cuts the requests in flight. `@tetsujs/lifecycle` stops accepting
connections, lets the requests in flight finish within a grace period,
then runs the closers — a pool, a database — and exits:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { Database } from "bun:sqlite";
const app = createApp({ routes: [] });
const db = new Database(":memory:");
// ---cut---
import { onShutdownSignals } from "@tetsujs/lifecycle";

const server = Bun.serve({ ...app, port: Number(Bun.env.PORT ?? 3000) });

onShutdownSignals(server, { close: [() => db.close()] });
```

The closers run after the server has stopped, so a request still in
flight never loses the database it is using. The process exits with `0`
when everything finished, and `1` when connections had to be cut.

Behind a load balancer, keep serving for a few seconds after the signal
and fail the readiness check meanwhile, so the balancer stops sending
traffic before the server stops taking it. Event streams and WebSockets
never finish on their own and are closed when the server starts to drain.
Both are in [Health checks and shutdown](/docs/guides/health-and-shutdown/)
and [`@tetsujs/lifecycle`](/docs/packages/lifecycle/).

The platform gives a stopping process a limited time before it kills it:
ten seconds for `docker stop` by default, thirty for a Kubernetes pod. The
shutdown has to fit in it — the pre-stop delay, `graceMs` (ten seconds by
default), `forceMs` and the closers together. Lower `graceMs` or raise the
platform's limit.

## A container

The official `oven/bun` image has Bun and nothing else the application
needs. The dependencies are installed in a layer of their own, so a change
to the code does not reinstall them:

```dockerfile
FROM oven/bun:1.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
```

```text
# .dockerignore
node_modules
.env
.git
```

- **`CMD` in its exec form**, a JSON array, makes Bun the container's main
  process, so `SIGTERM` reaches it and the shutdown above runs. The shell
  form, `CMD bun src/main.ts`, starts a shell that does not pass the
  signal on; the platform then kills the process when its time runs out,
  with every request still in flight.
- **`--production`** leaves out development dependencies. Bun runs
  TypeScript as it is, so `typescript` and `@types/bun` are not needed at
  runtime.
- **`--frozen-lockfile`** installs exactly what `bun.lock` records, and
  fails rather than resolving something else.
- **`USER bun`** runs the process as the unprivileged user the image
  provides, not as root.
- **`.env` stays out of the image.** Configuration comes from the
  platform's environment when the container starts.

Pin the Bun version the application is developed and tested with; the
framework requires Bun 1.4 or later.

## A single-file binary

`bun build --compile` bundles the application, its dependencies and Bun
itself into one executable:

```bash
NODE_ENV=production bun build --compile src/main.ts --outfile server
PORT=8080 ./server
```

The binary needs no `node_modules` and no Bun on the machine, and runs from
any directory. The notes application in `examples/app` — `bun:sqlite`, the
OpenAPI document and its page, request logs, graceful shutdown — builds
and serves this way, and the file is about 60 MB, most of it the runtime.

What stays the same and what does not:

- **The environment is read when the binary runs.** `Bun.env.PORT` is
  whatever the process is started with, and `SIGTERM` stops it gracefully,
  as it does under `bun`.
- **A `.env` file in the working directory is loaded**, as `bun` loads one.
  In production, where configuration comes from the platform, build with
  `--no-compile-autoload-dotenv` so that a stray file cannot change it.
- **`process.env.NODE_ENV` is replaced when the binary is built**, with the
  value the build ran under — `development` when it is not set. Libraries
  that branch on it keep that value whatever the process is started with,
  which is why the build above sets it. `Bun.env.NODE_ENV` is read at
  runtime. The framework reads neither.
- **Minifying renames classes and functions.** `--minify`, and
  `--production`, which implies it, turn `class OrderLockedError` into a
  name of a letter or two, and that name is what the error's
  `constructor.name` and pino's `err.type` show in a failure report. Leave
  identifiers alone in a server: without minification, or with
  `--minify-whitespace --minify-syntax`.

A binary runs on the operating system and processor it was built for.
Bun builds for another with `--target`; see Bun's documentation on
single-file executables.

## Before the first deploy

- The cookie secret comes from the environment, 32 random bytes or more —
  see [Cookies](/docs/concepts/cookies/).
- `secureHeaders()` on the application, for the security headers every
  response should carry — see [`@tetsujs/secure-headers`](/docs/packages/secure-headers/).
- A `reportError` receiver, so failures reach the application's logger
  instead of the console — see [Logging](/docs/guides/logging/).
- Behind a load balancer or a proxy, the client's address and HTTPS are
  the proxy's to report — see [Behind a proxy](/docs/guides/behind-a-proxy/).
- A body limit that fits the API: `maxBodySize` is 1 MiB by default — see
  [Request bodies](/docs/concepts/request-bodies/).
