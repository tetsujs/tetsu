/**
 * Bun alone: native routes and hand-written handlers — the ceiling.
 *
 * @module
 */

import { host } from "./host.ts";

const server = Bun.serve({
  port: 0,
  routes: {
    "/ping": { GET: () => Response.json({ pong: true }) },
    "/users/:id": {
      GET: (req) => Response.json({ id: req.params.id, by: "u1" }),
    },
    "/items": {
      POST: async (req) => {
        const body = (await req.json()) as { name?: unknown; qty?: unknown };

        if (typeof body.name !== "string" || typeof body.qty !== "number") {
          return Response.json({ error: "invalid" }, { status: 422 });
        }

        return Response.json({ name: body.name, qty: body.qty });
      },
    },
  },
  fetch: () => Response.json({ error: "not found" }, { status: 404 }),
});

host(server.port ?? 0);
