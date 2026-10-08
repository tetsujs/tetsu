---
title: Why write an HTTP framework in TypeScript in 2026?
description: Go and Rust are stricter than TypeScript. Why I still wrote Tetsu in TypeScript, and what a framework has to do to close part of the gap.
date: 2026-10-08
authors: tetsuodev
excerpt: Go and Rust are stricter than TypeScript, and agents now write much of our code. But someone still has to review it, and you review best in the language you already write. Why I wrote Tetsu in TypeScript, and what a framework can do to close part of the gap.
---

In September, Jarred Sumner, who builds Bun,
[wrote](https://x.com/jarredsumner/status/2103092824363401586) that
"JavaScript was never designed for the server", and that unless the engine
changes, Rust will replace it there. Many replies agreed and said to let
server-side JavaScript die. A week later Ryan Dahl, who created Node.js and
Deno and writes Rust as his main language,
[answered](https://x.com/rough__sea/status/2106813105594593704) that
application code belongs in JavaScript or TypeScript.

I had just written Tetsu, an HTTP framework for Bun, in TypeScript, and I'd
been asking myself the same question while building it. Here's my answer. It
starts with what Go and Rust do better, because they do a lot better.

## What Go and Rust do better

| | TypeScript | Go | Rust |
| --- | --- | --- | --- |
| Code with a type error | runs: Bun and Node don't check types | doesn't build | doesn't build |
| A value matches its type | not always: `any`, `as` and `JSON.parse` aren't checked | yes, except with `unsafe` or a data race | yes, except with `unsafe` |
| JSON with a missing field | passes, typed as whatever you claimed | the field quietly gets its zero value | `serde` refuses it, unless it's optional |
| Extra fields in a response | sent, unless something strips them | only the struct's fields are sent | only the struct's fields are sent |
| Errors | anything can throw, and the type doesn't say | that a call can fail is in the signature | `Result<T, E>` in the signature |
| Numbers | `number` is a float: 64-bit ids need `bigint` | sized integers | sized integers |
| CPU-heavy work | one thread per process | all cores | all cores |
| Dependencies | npm runs install scripts, Bun only for an allow list | fetching or building runs no code | build scripts run at build time |

TypeScript's types are erased before the code runs, so they're claims, and
Bun or Node will run code whose claims don't hold:

```ts twoslash
interface Order { id: number; total: number }
declare const res: Response;
export {};
// ---cut---
const order = (await res.json()) as Order; // compiles, and nothing checked it
JSON.parse('{"id": 9007199254740993}').id; // 9007199254740992
```

Rust is stricter almost everywhere. Its compiler refuses whole classes of bugs,
and `sqlx` can even check each SQL query against a real database at build
time. Go is simpler and has a careful
[supply chain](https://go.dev/blog/supply-chain), while npm runs install
scripts, which is how a worm spread through
[more than 500 packages](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)
in 2025. If your team writes Go or Rust, these are good reasons to stay there.

## Who reads the code

Then why TypeScript? Because of who reviews the code.

Agents write a lot of our code now, but someone still reviews it before it
goes to production, and has to understand it. Tetsu was built that way: Claude
wrote most of its code, and I reviewed every change. José Valim, who created
Elixir, [wrote](https://x.com/josevalim/status/2108167477469327411) this week
that because of coding agents he reviews significantly more code than before.
And most of what that review is for isn't a type error. In Stack Overflow's
[2025 survey](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/),
the most common frustration with AI tools was output that is almost right, and
45% of developers said debugging AI-generated code takes them longer.

Code that is almost right is exactly what a compiler can't see: a refund that
can exceed the order, a permission check on the wrong field, a status that
lets a cancelled order ship. Rust's compiler doesn't know your business rules
either.

Cloudflare learned that in November 2025, when a large part of the web
returned errors for about three hours. A database permissions change made a
query return duplicate rows, the file that feeds Cloudflare's bot detection
doubled in size, and it went over a limit of 200 features in the new proxy,
which is written in Rust. Rust had made the failure visible: it was an error
value the code had to handle. The code called `unwrap()` on it, and the proxy
[panicked](https://blog.cloudflare.com/18-november-2025-outage/). The
compiler did its job. No compiler can tell you that a file which usually holds
about 60 features will one day hold more than 200. Someone who knows the
system can.

Bun's own team just showed what a strict compiler is best at: they
[ported Bun from Zig to Rust](https://bun.com/blog/bun-in-rust) with Claude
Code so that use-after-free and double-free bugs would become compile errors.
Those are memory bugs, and application code on a garbage-collected runtime
doesn't have them. Its expensive bugs are in the business logic, and those are
caught by tests and by a person who knows the business and reads the code
fluently.

You read fluently in the language you already write. If your team writes Go,
that's Go, and you should pick Go. If it's a web team that writes TypeScript
every day, and its front end too, it's TypeScript. A model can write Rust for a
team that doesn't know Rust, but then nobody on the team can really review it.

So for a TypeScript team, the useful question is how to make TypeScript code
easy to review, and as safe as it can get.

## What makes code easy to review

Reviewing Tetsu's code made one thing clear to me: code is easy to review when
everything that runs is visible where you read it. Every language has ways to
hide it. Rust's derive and attribute macros generate code you never see. The
compiler checks it, but it isn't the code you review, and reading it takes
`cargo expand`. Go reads struct tags, which are plain strings, through
reflection. TypeScript has decorators and DI containers, which decide at
runtime what runs and what gets injected.

How much of that a project uses is the framework's choice more than the
language's. Tetsu uses none of it. It does use something TypeScript does better
than Go, and without the macros Rust needs: types computed from your own code,
such as a route's parameters from its path, or a request body's type from its
schema.

## How Tetsu helps

### A route reads top to bottom

A route in Tetsu is one object: the method, the path, schemas for each part of
the request and response, the hooks that run around it, and the handler.

```ts twoslash
import { hook, HttpError, route } from "@tetsujs/core";
import { z } from "zod";
interface User { id: number; role: "customer" | "support" }
interface Refund { id: number; orderId: number; amount: number }
declare const sessions: { verify(token: string | null): Promise<User | undefined> };
declare const refunds: { create(by: User, orderId: number, amount: number): Refund };
const RefundDto = z.object({ id: z.number(), orderId: z.number(), amount: z.number() });
// ---cut---
const auth = hook.beforeParse(async (ctx) => {
  const user = await sessions.verify(ctx.req.headers.get("authorization"));
  if (!user) throw new HttpError(401);
  return { user };
});

const refund = route({
  method: "POST",
  path: "/orders/:id/refund",
  schema: {
    params: z.object({ id: z.coerce.number() }),
    body: z.object({ amount: z.number().positive() }),
    response: { 200: RefundDto },
  },
  hooks: { beforeParse: [auth] },
  handler: (ctx) => refunds.create(ctx.user, ctx.params.id, ctx.body.amount),
});
```

A reviewer sees who can call it, what it accepts, what it returns and what it
does. That's also what lets them see what the route doesn't do: nothing here
stops a refund larger than the order, unless `refunds.create` checks it.
That's the almost-right bug from earlier. Neither the compiler nor the schema
can see it, but a reviewer with the whole route in front of them can ask.

Hooks sit in named slots that always run in the same order, so there's no
`next()` chain to trace. Anything else that runs for this route sits on its
group or the app, in the same form. There are no decorators, no container and
no plugins: a controller gets its dependencies as function arguments, and the
wiring is ordinary code in one file.

### Types show only what exists

`ctx` is never annotated. A field is in its type exactly when it exists at that
point: `ctx.params.id` because the path has `:id`, a number because the schema
converts it, `ctx.body` because the route declares a body, `ctx.user` because
`auth` returned it. Remove `auth`, and the handler stops compiling:

```ts twoslash
import { route } from "@tetsujs/core";
interface User { id: number }
declare function reportsFor(user: User): string[];
// ---cut---
// @errors: 2339
route({
  method: "GET",
  path: "/reports",
  handler: (ctx) => reportsFor(ctx.user),
});
```

A reviewer doesn't have to check by eye whether auth ran before this handler.
The compiler already did.

### Boundaries are parsed in one place

The schemas are the checks. A request with a missing or malformed field gets
a `422` that lists every issue, and the handler never runs. This is the old
advice to [parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/):
one schema at the edge instead of checks spread through the handler, and one
place for a reviewer to look.

Responses are parsed too, which closes one of the gaps from the table.
TypeScript lets an object with extra fields pass for a type with fewer, so a
stored user with a `passwordHash` passes for a public user. The response schema
runs on the way out, and its output is what gets sent. With Zod or Valibot,
that drops the hash. ArkType and TypeBox have to be told to:

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
interface StoredUser { id: number; name: string; passwordHash: string }
declare const users: { find(id: number): StoredUser };
// ---cut---
const PublicUser = z.object({ id: z.number(), name: z.string() });

route({
  method: "GET",
  path: "/users/:id",
  schema: { params: z.object({ id: z.coerce.number() }), response: { 200: PublicUser } },
  handler: (ctx) => users.find(ctx.params.id), // a stored user, passwordHash included
});

// GET /users/1 → 200 {"id":1,"name":"Ada"}
```

### Docs come from the code

The OpenAPI document is built from the same routes and schemas, so a reviewer
who approves a schema change has approved the docs too. Tetsu's own
documentation is written for agents as well as people: every page is also
served as Markdown, all of it is in one file at
[`/llms-full.txt`](/llms-full.txt), and the packages ship TSDoc that editors
and agents read from `node_modules`. An agent that reads the right docs writes
code that's closer to right, which leaves less for the reviewer.

## Why not Hono or Elysia

Both are good, and both infer types from the path and from schemas. Where they
differ from Tetsu is how the code around a handler is put together, and that's
what a reviewer reads. In Hono, middleware wraps the handler with `next()`, and
what runs for a route depends on the order of the `app.use()` calls. In
Elysia, the app is a chain of method calls, each extending the type of the
next, and a plugin's scope decides how far its hooks reach. Both are more
flexible than Tetsu.

Tetsu trades that flexibility for one shape: hooks in fixed slots, listed on
the route, its group or the app, and no plugins. It costs more typing, since
each route lists its own hooks, and it gives up things the others do well.
Hono runs on almost any runtime, and Elysia's Eden gives the front end the
server's types directly. [Comparison](/docs/more/comparison/) has the details.

## What it doesn't fix

A framework can make TypeScript safer at the HTTP boundary, but not stricter
everywhere. Errors still aren't in any signature, numbers are still floats,
CPU-heavy work still needs a worker, and a database row is still whatever the
driver returned unless you parse it too. Tetsu has a limit of its own: hooks
mounted on a group run for its routes but don't add to their types, so a
handler that reads `ctx.user` needs `auth` on its own route.

## Where TypeScript on the server is going

The first row of the table is closing. Bun is adding a type checker of its own,
[`bun check`](https://bun.com/docs/runtime/check), ported from typescript-go to
Rust and already in canary builds. `bun --check server.ts` checks the code before running
it, and `bun test --check` checks it before the tests, so code with a type
error no longer has to run at all. I tried the canary build on Tetsu's
repository: on the same 1,588 files, it reported the same errors as `tsc`,
with the same messages, in 0.22 seconds against 0.8 for TypeScript 7, on an
M5 Pro. The TypeScript compiler itself was rewritten in Go, and TypeScript 7
came out in July
[about ten times faster](https://www.infoworld.com/article/4196378/go-based-typescript-7-0-arrives.html).
For a team that reviews TypeScript, that means the type check can run on every
save and every test run, not only in CI.

There's money behind it too. Bun had no revenue when Anthropic bought it in
December 2025. Claude Code ships to millions of users as a Bun executable, so
Anthropic has a direct stake in Bun's quality, and Bun's
[own post](https://bun.com/blog/bun-joins-anthropic) about the deal says its
roadmap still includes replacing Node.js as the default runtime on the server.
Since then, [Bun 1.4](https://bun.com/blog/bun-v1.4) fixed more than 2,900
issues, the runtime itself was rewritten in Rust, and the `bun` package on npm
had [15 million downloads](https://api.npmjs.org/downloads/point/2026-09-01:2026-09-30/bun)
in September 2026, ten times
[more than a year before](https://api.npmjs.org/downloads/point/2025-09-01:2025-09-30/bun).
I have no ties to Anthropic, for the record.

Tetsu runs only on Bun, so if Bun stalls, so does Tetsu. All of this lowers
that risk without removing it.

## When I'd pick which

If your team writes Go or Rust, pick Go or Rust, for the same reason I picked
TypeScript: you'll review that code best.

If your team writes TypeScript, especially on the front end, TypeScript on the
server is a reasonable choice in 2026, if you do four things:

- Run `tsc --noEmit` in CI, or `bun check` once it's in a stable Bun release.
- Turn on `strict` and `noUncheckedIndexedAccess`, and ban `any` in the linter,
  for example with Biome's `noExplicitAny`.
- Parse every boundary with a schema: requests, responses, database rows,
  other services' replies and configuration.
- Choose tools that keep the code readable: no hidden wiring, nothing that runs
  without being visible where you read.

That's why I wrote Tetsu in TypeScript. Agents can write the code, but someone
still has to understand it, and the language you understand best is the one
you already write.

Tetsu is MIT licensed. The [quick start](/docs/quick-start/) builds a first
app with a test, and the code is on [GitHub](https://github.com/tetsujs/tetsu).
