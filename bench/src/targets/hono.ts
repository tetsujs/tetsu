/**
 * Hono, with the router a variant names: `default` is `hono` (its
 * SmartRouter picking RegExpRouter), `quick` is `hono/quick`
 * (LinearRouter, which registers faster and matches slower).
 *
 * @module
 */

import { sValidator } from "@hono/standard-validator";
import { createMiddleware } from "hono/factory";
import { host } from "./host.ts";
import { ItemSchema } from "./item.ts";

const variant = Bun.env.BENCH_VARIANT ?? "default";

const { Hono } =
  variant === "quick" ? await import("hono/quick") : await import("hono");

const auth = createMiddleware<{ Variables: { user: { id: string } } }>(
  async (c, next) => {
    c.set("user", { id: "u1" });
    await next();
  },
);

const observe = createMiddleware(async (_, next) => {
  await next();
});

const app = new Hono()
  .get("/ping", (c) => c.json({ pong: true }))
  .get("/users/:id", auth, observe, (c) =>
    c.json({ id: c.req.param("id"), by: c.get("user").id }),
  )
  .post("/items", sValidator("json", ItemSchema), (c) =>
    c.json(c.req.valid("json")),
  );

const server = Bun.serve({ port: 0, fetch: app.fetch });

host(server.port ?? 0);
