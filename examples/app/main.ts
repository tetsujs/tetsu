/**
 * Starts the notes application.
 *
 * ```sh
 * bun examples/app/main.ts
 * curl -X POST localhost:3000/api/notes -H 'authorization: Bearer ada-token' \
 *   -H 'content-type: application/json' -d '{"title":"first"}'
 * curl localhost:3000/api/notes -H 'authorization: Bearer ada-token'
 * curl localhost:3000/api/notes/1 -H 'authorization: Bearer grace-token'  # 404
 * open http://localhost:3000/docs
 * ```
 *
 * @module
 */

import { Database } from "bun:sqlite";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { buildApp } from "./app.ts";

const db = new Database(Bun.env.NOTES_DB ?? "notes.sqlite", { create: true });

const server = Bun.serve({
  ...buildApp(db),
  port: Number(Bun.env.PORT ?? 3000),
});

onShutdownSignals(server, { close: [() => db.close()] });

console.log(`notes on ${server.url}`);
