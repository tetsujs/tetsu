---
title: Webhooks
description: Receiving signed webhooks — the signature checked over the raw bytes before validation, each event handled once, and the answer sent before the work is done.
sidebar:
  order: 10
---

This guide receives webhooks from a payment provider. It checks the
signature over the bytes as they were sent, records each event once however
often it is delivered, and answers before the work the event asks for is
done.

## Checking the signature

A signature holds only over the exact bytes the sender signed: parsed and
serialized again, the same JSON may come out with its keys in another
order, and the signature no longer matches. `rawBody: true` on a route
keeps the bytes in `ctx.rawBody` while the body is still parsed and
validated into `ctx.body`. A `beforeValidation` hook runs between the two.
See [Request bodies](/docs/concepts/request-bodies/).

The provider here signs in the style Stripe uses: a header
`t=1767225600,v1=5257a869…` with a timestamp and a hex HMAC-SHA256 of the
timestamp and the body joined by a dot. Other providers differ in the
details; the shape of the check stays the same.

```ts twoslash
import { timingSafeEqual } from "node:crypto";

const toleranceSeconds = 300;

export function signatureHolds(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!header) return false;

  const fields = header.split(",").map((field) => field.trim().split("="));
  const timestamp = Number(fields.find(([key]) => key === "t")?.[1]);
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value ?? "");

  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = new Bun.CryptoHasher("sha256", secret).update(`${timestamp}.`).update(body).digest();

  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");

    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

- **`timingSafeEqual`, not `===`.** A string comparison stops at the first
  difference, and its timing tells an attacker how much of a forged
  signature was right. `timingSafeEqual` throws on buffers of different
  lengths, so the length is checked first.
- **The timestamp is signed too.** One older than five minutes is refused,
  so a recorded request cannot be replayed later.
- **Every `v1` counts.** A provider rotating its secret sends signatures
  made with both the old and the new one.

The hook that runs the check is built once from the secret:

```ts twoslash
declare function signatureHolds(body: Uint8Array, header: string | null, secret: string): boolean;
// ---cut---
import type { Requires } from "@tetsujs/core";
import { hook, httpError } from "@tetsujs/core";

export function signedWebhook(secret: string | undefined) {
  if (!secret) throw new Error("signedWebhook: the secret is empty");

  return hook.beforeValidation((ctx: Requires<{ rawBody: Uint8Array }>) => {
    if (!signatureHolds(ctx.rawBody, ctx.req.headers.get("x-signature"), secret)) {
      throw httpError(401, "BAD_SIGNATURE", "The signature does not match the body");
    }
  });
}
```

An empty secret — a variable nobody set — fails at startup, since anyone
can sign with an empty key. The hook declares that it needs `ctx.rawBody`
with [`Requires`](/docs/concepts/context/), so mounting it on a route
without `rawBody: true` does not compile.

Checking in `beforeValidation` refuses an unsigned request with `401`
before the schema sees it, so a stranger gets no `422` describing what the
schema expects. A body that is not JSON is refused with `400` while it is
parsed, before the hook runs.

## The route

```ts twoslash
import type { Requires } from "@tetsujs/core";
import { hook, httpError } from "@tetsujs/core";
import type { Database } from "bun:sqlite";
declare function signatureHolds(body: Uint8Array, header: string | null, secret: string): boolean;
function signedWebhook(secret: string | undefined) {
  if (!secret) throw new Error("empty");
  return hook.beforeValidation((ctx: Requires<{ rawBody: Uint8Array }>) => {
    if (!signatureHolds(ctx.rawBody, ctx.req.headers.get("x-signature"), secret)) throw httpError(401, "BAD_SIGNATURE");
  });
}
declare function eventInbox(db: Database): { receive(id: string, type: string, payload: string): boolean };
// ---cut---
import { controller, route } from "@tetsujs/core";
import { z } from "zod";

const PaymentEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

interface WebhooksDeps {
  readonly inbox: ReturnType<typeof eventInbox>;
  readonly secret: string | undefined;
}

export const webhooksController = controller("Webhooks", ({ inbox, secret }: WebhooksDeps) => {
  const signed = signedWebhook(secret);

  return {
    payments: route({
      method: "POST",
      path: "/webhooks/payments",
      rawBody: true,
      schema: { body: PaymentEvent },
      hooks: { beforeValidation: [signed] },
      docs: { hidden: true },
      handler: (ctx) => {
        inbox.receive(ctx.body.id, ctx.body.type, new TextDecoder().decode(ctx.rawBody));
      },
    }),
  };
});
```

The handler returns nothing, so the answer is `204`.

- **The schema accepts every event type.** Providers add new types without
  notice. A schema that refused them would answer `422`, and the sender
  would retry each one for days. Check the type where the event is
  handled.
- **The raw body is stored**, not `ctx.body`: the Zod object strips fields
  it does not declare, and the raw text keeps everything the sender
  signed.
- **`docs: { hidden: true }`** leaves the route out of the
  [OpenAPI document](/docs/packages/openapi/).
- **The body limit** is the application's `maxBodySize`, 1 MiB by default.
  Set `maxBodySize` on this route if the provider's events are larger.

## Receiving an event twice

Webhooks are delivered at least once. A sender that did not hear the
answer in time sends the same event again. Every event carries an id, so a
table with that id as its primary key turns a second delivery into a
no-op:

```ts twoslash
import type { Database } from "bun:sqlite";

export function eventInbox(db: Database) {
  db.run(`create table if not exists webhook_events (
    id text primary key,
    type text not null,
    payload text not null,
    received_at integer not null,
    processed_at integer
  )`);

  const insert = db.prepare(
    "insert into webhook_events (id, type, payload, received_at) values (?, ?, ?, ?) on conflict (id) do nothing",
  );

  return {
    receive: (id: string, type: string, payload: string) =>
      insert.run(id, type, payload, Date.now()).changes === 1,
  };
}
```

`receive` answers whether the event was new. A duplicate is still answered
`204`, so the sender stops sending it. The check and the write are one
atomic statement, so two deliveries arriving at once cannot both be taken
as new; a separate check followed by a write could let both through.

## Answering fast, working after

A sender waits a few seconds and then counts the delivery as failed. The
work an event asks for — updating an order, sending an email — can take
longer, and a failure half-way must not lose the event. The table above is
already a queue: the handler records the event and answers, and a job
processes what is still pending:

```ts twoslash
import { Database } from "bun:sqlite";
declare const db: Database;
declare const payments: { apply(type: string, event: unknown): Promise<void> };
// ---cut---
const pending = db.query<{ id: string; type: string; payload: string }, []>(
  "select id, type, payload from webhook_events where processed_at is null order by received_at limit 100",
);

const processed = db.prepare("update webhook_events set processed_at = ? where id = ?");

export async function processEvents(): Promise<void> {
  for (const event of pending.all()) {
    await payments.apply(event.type, JSON.parse(event.payload));

    processed.run(Date.now(), event.id);
  }
}
```

Run it every few seconds as in
[Background jobs](/docs/guides/background-jobs/#an-interval). An event
whose processing throws stays pending and is tried again on the next run.
Count the attempts in the table and set aside an event past a limit, so
one that can never succeed does not block the rest.

Starting the work after the response without waiting for it — in an
`afterResponse` hook, or a promise the handler does not return — needs no
table, but the work lives only in memory. The sender has been told the
event arrived and will not send it again, so a restart or deploy half-way
loses it for good. That is fine for a cache to warm; for anything the
event is the only record of, keep the table.

## Testing

A test signs the body the way the sender does and sends it to a served
application, with the inbox on an in-memory database:

```ts twoslash
// @filename: webhooks.ts
import type { Requires } from "@tetsujs/core";
import { controller, hook, httpError, route } from "@tetsujs/core";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
function signatureHolds(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!header) return false;
  const fields = header.split(",").map((field) => field.trim().split("="));
  const timestamp = Number(fields.find(([key]) => key === "t")?.[1]);
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = new Bun.CryptoHasher("sha256", secret).update(`${timestamp}.`).update(body).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
function signedWebhook(secret: string | undefined) {
  if (!secret) throw new Error("empty");
  return hook.beforeValidation((ctx: Requires<{ rawBody: Uint8Array }>) => {
    if (!signatureHolds(ctx.rawBody, ctx.req.headers.get("x-signature"), secret)) throw httpError(401, "BAD_SIGNATURE");
  });
}
export function eventInbox(db: Database) {
  db.run("create table if not exists webhook_events (id text primary key, type text not null, payload text not null, received_at integer not null, processed_at integer)");
  const insert = db.prepare("insert into webhook_events (id, type, payload, received_at) values (?, ?, ?, ?) on conflict (id) do nothing");
  return { receive: (id: string, type: string, payload: string) => insert.run(id, type, payload, Date.now()).changes === 1 };
}
const PaymentEvent = z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.record(z.string(), z.unknown()) }) });
export const webhooksController = controller(
  "Webhooks",
  ({ inbox, secret }: { inbox: ReturnType<typeof eventInbox>; secret: string | undefined }) => {
    const signed = signedWebhook(secret);
    return {
      payments: route({
        method: "POST",
        path: "/webhooks/payments",
        rawBody: true,
        schema: { body: PaymentEvent },
        hooks: { beforeValidation: [signed] },
        handler: (ctx) => {
          inbox.receive(ctx.body.id, ctx.body.type, new TextDecoder().decode(ctx.rawBody));
        },
      }),
    };
  },
);
// @filename: webhooks.test.ts
// ---cut---
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { eventInbox, webhooksController } from "./webhooks";

const secret = "test-secret";
const inbox = eventInbox(new Database(":memory:"));
const request = serve(createApp({ routes: webhooksController({ inbox, secret }) }));

function signed(body: string, at = Math.floor(Date.now() / 1000)) {
  const signature = new Bun.CryptoHasher("sha256", secret).update(`${at}.${body}`).digest("hex");

  return { "x-signature": `t=${at},v1=${signature}` };
}

const event = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { object: {} } });

test("a signed event is accepted", async () => {
  const res = await request("/webhooks/payments", { method: "POST", body: event, headers: signed(event) });

  expect(res.status).toBe(204);
});

test("an event signed an hour ago is refused", async () => {
  const hourAgo = Math.floor(Date.now() / 1000) - 3_600;
  const res = await request("/webhooks/payments", { method: "POST", body: event, headers: signed(event, hourAgo) });

  expect(res.status).toBe(401);
});
```

A test that sends the same event twice and counts the rows checks the
inbox. More on testing is in [Testing](/docs/guides/testing/).
