---
title: Installation
description: What Tetsu needs — Bun, TypeScript with strict on, Bun's types and a module resolution that reads package exports — and how to add it to a project.
---

The core is the only package an application needs:

```bash
bun add @tetsujs/core
```

## Requirements

| | |
| --- | --- |
| Bun | 1.4 or later |
| TypeScript | 5.7 or later, including 7, with `strict` on |
| Bun's types | `@types/bun` |
| `moduleResolution` | `bundler`, `node16` or `nodenext` |

A project made with `bun init` already has Bun's types and a
`tsconfig.json` that works. For an existing project, add Bun's types:

```bash
bun add -d @types/bun
```

and check `tsconfig.json` against this one:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

- `strict` is required. Without `strictNullChecks` the types cannot tell a
  field that exists from one that might not.
- The old `node` resolution (also called `node10`) does not read package
  `exports` and reports `@tetsujs/core` as not found.
- Stricter flags such as `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` work: the packages are checked under
  `@tsconfig/strictest`.

Bun's types also describe what Bun adds to the platform's globals. Their
`fetch` has `preconnect`, so `typeof fetch` requires it too, and a
stand-in typed with it, such as a fake in a test, fails to compile with
"Property 'preconnect' is missing". Type a dependency on `fetch` by its
call instead. `fetch` itself still fits:

```ts twoslash
import { controller, route } from "@tetsujs/core";
// ---cut---
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const weatherController = controller("Weather", ({ fetch }: { fetch: Fetch }) => ({
  today: route({
    method: "GET",
    path: "/weather",
    handler: async () => (await fetch("https://api.example.com/today")).json(),
  }),
}));

weatherController({ fetch }); // the real one
weatherController({ fetch: async () => Response.json({ sunny: true }) }); // a fake, in a test
```

## A validation library

Tetsu validates through [Standard Schema](https://standardschema.dev), which
Zod, Valibot and ArkType implement. The core depends on none of them;
install the one you use:

```bash
bun add zod
```

TypeBox needs the adapter [`@tetsujs/typebox`](/docs/packages/typebox/).

## Other packages

Everything else is optional. All packages share one version number and are
released together.

| Package | What it adds |
| --- | --- |
| [`@tetsujs/openapi`](/docs/packages/openapi/) | an OpenAPI 3.1 document and a docs page, generated from the routes |
| [`@tetsujs/typebox`](/docs/packages/typebox/) | TypeBox schemas as DTOs, file uploads included |
| [`@tetsujs/cors`](/docs/packages/cors/) | CORS |
| [`@tetsujs/rate-limit`](/docs/packages/rate-limit/) | rate limiting with a replaceable store |
| [`@tetsujs/request-id`](/docs/packages/request-id/) | request ids |
| [`@tetsujs/request-log`](/docs/packages/request-log/) | access and arrival logs |
| [`@tetsujs/secure-headers`](/docs/packages/secure-headers/) | security headers |
| [`@tetsujs/sse`](/docs/packages/sse/) | server-sent events and streamed responses |
| [`@tetsujs/lifecycle`](/docs/packages/lifecycle/) | graceful shutdown |

Next: [Quick start](/docs/quick-start/).
