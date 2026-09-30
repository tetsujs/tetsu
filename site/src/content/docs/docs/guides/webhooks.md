---
title: Webhooks
description: Receiving signed webhooks — the signature checked over the raw bytes before validation, each event handled once, and the answer sent before the work is done.
sidebar:
  order: 10
---

This guide receives webhooks from a payment provider: it checks the
signature over the bytes as they were sent, validates the event, records
it once however often it is delivered, and answers before the work the
event asks for is done.

## Keeping the bytes

A sender signs the body as bytes, and the signature holds only over those
exact bytes: parsed and serialized again, the same JSON may come out with
its keys in another order or its numbers written differently, and the
signature no longer matches. The handler, meanwhile, wants the event as a
validated object.

`rawBody: true` on a route keeps both. The bytes are in `ctx.rawBody`, the
body is parsed and validated into `ctx.body` as on any route, and a
`beforeValidation` hook runs between the two — after the body is read,
before anything is validated. See
[Request bodies](/docs/concepts/request-bodies/).

## Checking the signature

The provider in this guide sends its signature in the style Stripe uses: a
header `t=1767225600,v1=5257a869…` carrying a timestamp and an HMAC-SHA256,
in hex, of the timestamp and the body joined by a dot. Other providers name
the header differently and sign something slightly different; the shape of
the check stays the same.

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

- **The comparison takes the same time** however many bytes match.
  Comparing strings with `===` stops at the first difference, and the time
  it takes tells an attacker how much of a forged signature was right.
  `timingSafeEqual` refuses buffers of different lengths, so the length is
  checked first; a length reveals nothing, since every valid signature has
  the same one.
- **The timestamp is signed too**, and one older than five minutes is
  refused, so a request somebody recorded cannot be replayed later.
- **Every `v1` counts.** A provider rotating its secret signs with the old
  and the new one for a while, and sends both.

`Bun.CryptoHasher` given a key computes the HMAC synchronously. The Web
Crypto API — `crypto.subtle.importKey` and `crypto.subtle.verify` — does
the same asynchronously, and compares the signature itself.

The hook that runs the check is built from the secret, so it is made once
where the application is wired:

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

An empty secret — a variable nobody set — is refused when the application
starts: anyone can compute a signature with an empty key. The hook declares that it needs
`ctx.rawBody` with [`Requires`](/docs/concepts/context/), so mounting it on
a route without `rawBody: true` does not compile.

Checking in `beforeValidation` rather than in the handler means an unsigned
request is refused with `401` before the schema looks at it, so a
stranger learns nothing from a `422` listing what the schema expected. A
body that is not JSON at all is refused with `400` while it is parsed,
before the hook runs — it could not have been a valid event either way.

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

The handler returns nothing, so the answer is `204`, which every sender
takes as delivered.

- **The schema accepts every event type.** A provider sends types the
  application does not handle, and new ones appear without notice. A
  schema that refused them would answer `422`, and the sender would retry
  each of them for days. The type is checked where the event is handled.
- **What is stored is the raw body**, not `ctx.body`. The schema checks the
  fields this route relies on and, as a Zod object does by default, strips
  the rest; the raw text keeps everything the sender signed.
- **`docs: { hidden: true }`** leaves the route out of the
  [OpenAPI document](/docs/packages/openapi/). It is called by one sender,
  which does not read your document.
- **The body limit** is the application's `maxBodySize`, 1 MiB unless it
  was changed. Raise it on this route alone, with `maxBodySize`, if the
  provider's events are larger.

## Receiving an event twice

Webhooks are delivered at least once. A sender that did not hear the
answer in time — a timeout, a connection reset after the handler ran —
sends the same event again, and the application has to recognize it.

Tetsu has no idempotency package at the moment: what to remember, for how
long, and what a duplicate arriving during the first attempt gets differ
too much between applications. For webhooks the answer is short, because
every event carries an id. A table with that id as its primary key turns a
second delivery into a no-op:

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
`204`: it was delivered, and the sender should stop sending it.

The insert is atomic, so two deliveries of one event arriving at once
cannot both be taken as new. That is also why the id is recorded in the
same statement as the event itself — a check followed by a separate write
leaves a gap in which both deliveries pass the check.

## Answering fast, working after

A sender waits a few seconds for the answer and then counts the delivery
as failed. Work the event asks for — updating an order, sending an email,
calling another service — takes longer than that on a bad day, and a
failure half-way through must not lose the event.

The table above is already a queue: the handler records the event and
answers, and a job processes what has not been processed yet:

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

Run it every few seconds as in [Background jobs](/docs/guides/background-jobs/#an-interval),
which also waits for a run in progress when the server stops. An event
whose processing throws stays unprocessed and is tried again on the next
run; count the attempts in the table, and set aside an event past a
number of them, so one that can never succeed does not hold up the rest.

The other way is to start the work after the response without waiting for
it: an `afterResponse` hook on the route, or a promise the handler starts
and does not return. The answer goes out at once, and nothing needs a
table. The cost is that the work lives only in memory. The sender has
already been told the event arrived, so it never sends it again, and a
process that is restarted, deployed or killed half-way loses the work for
good — the shutdown waits for requests in flight, not for promises nobody
returned. A failure there is reported with `reportError`, and nothing
retries it.

That is acceptable for work whose loss costs nothing — a cache to warm, a
notification that is nice to have. For anything the sender's event is the
only record of, keep the table.

## Testing

A test signs the body the way the sender does and sends it to a served
application, with the inbox on a database in memory:

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
inbox as well. More on serving an application in tests is in
[Testing](/docs/guides/testing/).
