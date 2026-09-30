---
title: Installation
description: What Tetsu needs — Bun, TypeScript, Bun's types and a module resolution that reads package exports — and how to add it to a project.
---

Tetsu is a set of packages on npm under `@tetsujs`. The core is one of them,
and the only one an application needs.

```bash
bun add @tetsujs/core
```

## Requirements

| | |
| --- | --- |
| Bun | 1.4 or later |
| TypeScript | 5.7 or later, TypeScript 7 included, with `strict` on |
| Bun's types | `@types/bun` |
| `moduleResolution` | `bundler`, `node16` or `nodenext` |

The framework is written against Bun's own router, server and cookies, so it
runs on Bun only. The types are a large part of what it offers, so they are
tested as a feature: every release is checked against TypeScript 5.7, the
newest 5.x and the TypeScript 7 the repository itself is built with.

### Bun's types

The public types name Bun's own — `Bun.Server`, `CookieMap` — so a project
needs `@types/bun`. `bun init` adds it; otherwise:

```bash
bun add -d @types/bun
```

### Module resolution

The packages declare their entry points in `exports`. The `bundler` mode
that `bun init` writes reads them, and so do `node16` and `nodenext`. The
old `node` mode (also called `node10`) does not, and reports
`@tetsujs/core` as not found.

A `tsconfig.json` that works, close to what `bun init` generates:

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

`strict` is required: without `strictNullChecks` the inference that types
`ctx` cannot tell a field that exists from one that might not, and the
checks on the order of hooks lose their meaning. Stricter flags such as
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are supported —
the packages are checked under `@tsconfig/strictest`.

## A validation library

Tetsu validates through [Standard Schema](https://standardschema.dev), an
interface that Zod, Valibot and ArkType implement. The core depends on none
of them; install the one you use:

```bash
bun add zod
```

TypeBox needs an adapter, which is a package of its own —
[`@tetsujs/typebox`](/docs/packages/typebox/).

## Other packages

Everything else is optional and installed when needed. All packages share
one version number and are released together.

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

The packages are published as JavaScript with declaration files, built
from TypeScript, with npm provenance. None of them reads the environment:
configuration is passed in by your code.

Next: [Quick start](/docs/quick-start/).
