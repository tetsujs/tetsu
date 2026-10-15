/**
 * Serves the orders on the database `DATABASE_URL` names, once the
 * migrations have run on it.
 *
 * ```sh
 * export DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop
 * bun packages/sql/src/cli.ts migrations:run --dir examples/sql/migrations
 * bun examples/sql/main.ts
 * psql "$DATABASE_URL" -c "insert into customers (email, name) values ('ada@example.com', 'Ada')"
 * curl -X POST localhost:3000/customers/1/orders \
 *   -H 'content-type: application/json' -d '{"total":"12.50","tags":["gift"]}'
 * curl localhost:3000/customers/1/orders
 * curl -X POST localhost:3000/customers/9/orders \
 *   -H 'content-type: application/json' -d '{"total":"1.00"}'  # 404
 * ```
 *
 * @module
 */

import { createApp } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { database, verifySchema } from "@tetsujs/sql";
import { schema } from "./db.generated.ts";
import { ordersController } from "./orders.ts";

const url = Bun.env.DATABASE_URL;

if (url === undefined) {
  throw new Error("set DATABASE_URL to the database to serve the orders of");
}

const db = database(schema, { url });

await verifySchema(db, schema);

const server = Bun.serve({
  ...createApp({ routes: ordersController(db) }),
  port: Number(Bun.env.PORT ?? 3000),
});

onShutdownSignals(server, { close: [() => db.destroy()] });

console.log(`orders on ${server.url}`);
