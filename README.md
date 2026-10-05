<p align="center">
  <a href="https://tetsujs.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tetsujs.com/logo-dark.svg">
      <img src="https://tetsujs.com/logo-light.svg" alt="Tetsu" width="360">
    </picture>
  </a>
</p>

<p align="center">
  <b>No magic. Just iron.</b><br>
  HTTP framework for Bun
</p>

<p align="center">
  <a href="https://tetsujs.com/docs/">Documentation</a> ·
  <a href="https://tetsujs.com/docs/quick-start/">Quick start</a> ·
  <a href="https://tetsujs.com/docs/packages/core/">Packages</a>
</p>

Tetsu (鉄, "iron") is an HTTP framework for Bun. Controllers get their
dependencies as function arguments, hooks run in fixed slots instead of a
middleware chain, and the compiler infers every type from the path to the
handler. There are no decorators, no DI container and no dependencies in
the core.

```ts
import { controller, createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const users = controller("Users", ({ repo }: { repo: UserRepository }) => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const user = repo.find(ctx.params.id); // ctx.params.id is a number

      if (!user) throw httpError(404, "USER_NOT_FOUND");

      return user;
    },
  }),
}));

Bun.serve({ ...createApp({ routes: users({ repo }) }) });
```

Nothing here is annotated. A request with a bad id gets a `422` and never
reaches the handler.

## Install

```bash
bun add @tetsujs/core
```

Tetsu needs Bun 1.4 or later and TypeScript 5.7 or later. See
[Installation](https://tetsujs.com/docs/installation/).

## Documentation

Everything is on **[tetsujs.com](https://tetsujs.com/docs/)**: a
[quick start](https://tetsujs.com/docs/quick-start/), the
[key concepts](https://tetsujs.com/docs/key-concepts/), guides for
testing, authentication, deploying and more, and a reference for every
export. For AI tools, the whole documentation is in one file,
[llms-full.txt](https://tetsujs.com/llms-full.txt), and every page is also
served as Markdown: add `.md` to its address, as in
[docs/packages/core.md](https://tetsujs.com/docs/packages/core.md). Every
export and option is also documented in the type definitions the packages
ship, which editors and tools read from `node_modules`.

## Packages

| Package | |
| --- | --- |
| [`@tetsujs/core`](https://tetsujs.com/docs/packages/core/) | the framework |
| [`@tetsujs/cors`](https://tetsujs.com/docs/packages/cors/) | CORS headers and preflight responses |
| [`@tetsujs/lifecycle`](https://tetsujs.com/docs/packages/lifecycle/) | graceful shutdown |
| [`@tetsujs/openapi`](https://tetsujs.com/docs/packages/openapi/) | an OpenAPI 3.1 document and docs page from the routes |
| [`@tetsujs/rate-limit`](https://tetsujs.com/docs/packages/rate-limit/) | fixed-window rate limiting |
| [`@tetsujs/request-id`](https://tetsujs.com/docs/packages/request-id/) | request ids |
| [`@tetsujs/request-log`](https://tetsujs.com/docs/packages/request-log/) | request logs |
| [`@tetsujs/secure-headers`](https://tetsujs.com/docs/packages/secure-headers/) | security headers |
| [`@tetsujs/sse`](https://tetsujs.com/docs/packages/sse/) | server-sent events and streamed responses |
| [`@tetsujs/typebox`](https://tetsujs.com/docs/packages/typebox/) | TypeBox schemas with compiled validation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability privately,
as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
