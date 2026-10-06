---
title: Deploy to production
description: Serving the application with Bun.serve, configuration from the environment, graceful shutdown, a container image and a single-file binary.
sidebar:
  order: 4
---

This page takes an application from `bun src/main.ts` on a laptop to
production: serving, configuration, graceful shutdown, and two ways to
ship it — a container image and a single-file binary.

There is no production mode. The application runs the same code
everywhere, and `main.ts` passes in what differs.

There is no build step either: Bun runs TypeScript as it loads it, so the
container below runs `src/main.ts` as it is. A
[single-file binary](#a-single-file-binary) is the option for when you
want one.

## Serving

`createApp` returns what `Bun.serve` takes, so Bun's own options go next
to it:

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

The port, hostname, TLS, idle timeout and Bun's body size cap are all
`Bun.serve` options. An option written after the spread wins.

The idle timeout, 10 seconds unless set, closes a connection that sends
nothing for that long. An event stream from `sse()` sets its own
request's timeout above its heartbeat, except on a unix socket, such as
one nginx on the same machine connects to: Bun ignores a request's timeout
there, and the heartbeat has to stay under 8 seconds. See
[Idle connections](/docs/packages/sse/#idle-connections).

Without a `hostname`, Bun listens on every interface, which is what a
container needs. A server on `localhost` only is unreachable from outside
the container.

Bun compresses no response. A proxy or a CDN in front can, on its own
processor rather than the application's. nginx does with `gzip on`, and
compresses only `text/html` until `gzip_types` names more types, such as
`application/json`. Files can go out compressed without a proxy:
[`@tetsujs/static`](/docs/packages/static/#compressed-copies) sends the
copies a build compressed once.

## Configuration

The core reads no environment variables. `main.ts` reads the environment
once, checks it, and passes values in: the port to `Bun.serve`, the cookie
secret to `createApp`, a limit to `rateLimit()`. A missing secret then
stops the process at startup, not on the first request that needs it.

`NODE_ENV` changes nothing in the framework. A difference between
environments is a value `main.ts` passes, such as
`validateResponses: Bun.env.NODE_ENV !== "production"`. Keep response
checks on unless a measurement says otherwise: a response schema that
strips unknown keys is also what keeps a field like `passwordHash` out of
the JSON; see [Responses](/docs/concepts/responses/#what-is-serialized).

## Stopping without cutting requests

A deploy, a scale-down or a restart sends the process `SIGTERM`.
`onShutdownSignals()` from `@tetsujs/lifecycle` stops accepting
connections, lets requests in flight finish within a grace period, then
runs the closers and exits:

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

Closers run after the server has stopped, so no request loses the
database it is using. The process exits with `0`, or `1` when connections
had to be cut or a closer failed.

Behind a load balancer, add a pre-stop delay, `preStopDelayMs`, and fail
the readiness check during it, so traffic stops arriving before the server
stops. Event streams and WebSockets never finish on their own; close them
on the `draining` signal. Both are in
[Health checks and shutdown](/docs/guides/health-and-shutdown/).

The platform kills a stopping process after a limit: ten seconds for
`docker stop` by default, thirty for a Kubernetes pod. The shutdown must
fit in it: the pre-stop delay, `graceMs` (ten seconds by default),
`forceMs` and the closers together. Lower `graceMs` or raise the
platform's limit.

## A container

The official `oven/bun` image has everything the application needs.
Dependencies are installed in their own layer, so a code change does not
reinstall them:

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

- **`CMD` in exec form**, a JSON array, makes Bun the main process, so
  `SIGTERM` reaches it. The shell form, `CMD bun src/main.ts`, starts a
  shell that does not pass the signal on, and the platform kills the
  process with its requests in flight.
- **`--production`** skips development dependencies. Bun runs TypeScript
  directly, so `typescript` is not needed at runtime.
- **`--frozen-lockfile`** installs exactly what `bun.lock` records.
- **`USER bun`** runs the process as the image's unprivileged user.
- **`.env` stays out of the image.** Configuration comes from the
  platform's environment.

Pin the Bun version you develop and test with. Tetsu requires Bun 1.4 or
later.

## A single-file binary

`bun build --compile` bundles the application, its dependencies and Bun
itself into one executable of about 60 MB:

```bash
NODE_ENV=production bun build --compile src/main.ts --outfile server
PORT=8080 ./server
```

The binary needs no `node_modules` and no Bun on the machine. Environment
variables are read when it runs, and `SIGTERM` stops it gracefully. Some
things differ from running under `bun`:

- **`process.env.NODE_ENV` is fixed at build time**, to the value the
  build ran with, or `development` when unset. That is why the build above
  sets it. `Bun.env.NODE_ENV` is still read at runtime.
- **A `.env` file in the working directory is loaded.** Build with
  `--no-compile-autoload-dotenv` so a stray file cannot change production
  configuration.
- **Do not minify names.** `--minify` and `--production` rename classes,
  so an error's `constructor.name` in a failure report becomes a letter or
  two. Build without them, or with `--minify-whitespace --minify-syntax`.

A binary runs on the operating system and processor it was built for. To
build for another, use `--target`; see Bun's documentation on single-file
executables.

## Before the first deploy

- The cookie secret comes from the environment, 32 random bytes or more —
  see [Cookies](/docs/concepts/cookies/).
- `secureHeaders()` on the application — see
  [`@tetsujs/secure-headers`](/docs/packages/secure-headers/).
- A `reportError` receiver, so failures reach your logger instead of the
  console — see [Logging](/docs/guides/logging/).
- Behind a load balancer or a proxy, the client's address and HTTPS come
  from the proxy — see [Behind a proxy](/docs/guides/behind-a-proxy/).
- Behind nginx, which buffers a proxied response by default, a live
  `stream()` sends `x-accel-buffering: no`, as `sse()` does on its own —
  see [`@tetsujs/sse`](/docs/packages/sse/).
- A body limit that fits the API: `maxBodySize` is 1 MiB by default — see
  [Request bodies](/docs/concepts/request-bodies/#size-limits). A proxy in
  front has a limit of its own, and the lower one wins: nginx's
  `client_max_body_size` is 1 MB by default.
