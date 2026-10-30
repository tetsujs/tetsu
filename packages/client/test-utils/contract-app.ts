/**
 * An application with a route of each kind a contract has to hold, for the
 * tests of the generator and the frontends in `fixtures/`: its contract is
 * generated, committed, and checked to equal `ContractOf<typeof app>`.
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { z } from "zod";

interface Category {
  readonly name: string;
  children: Category[];
}

interface Owner {
  name: string;
  since: Date;
}

const Owner: z.ZodType<Owner, Owner> = z.object({
  name: z.string(),
  since: z.date(),
});

const Category: z.ZodType<Category> = z.object({
  name: z.string(),
  children: z.lazy(() => z.array(Category)),
});

const User = z.object({
  id: z.number(),
  name: z.string(),
  role: z.enum(["admin", "user"]),
  createdAt: z.date(),
  note: z.string().optional(),
  tags: z.array(z.string()),
  links: z.record(z.string(), z.url()),
  location: z.tuple([z.number(), z.number()]).nullable(),
  range: z.tuple([z.number(), z.number().optional()]),
});

const NotFound = z.object({
  status: z.literal(404),
  error: z.literal("USER_NOT_FOUND"),
  message: z.string(),
});

const Problem = z.object({ title: z.string(), detail: z.string().optional() });

const Step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), delta: z.string(), at: z.date() }),
  z.object({ type: z.literal("done") }),
]);

/** What a handler of an event stream answers with, as `sse()` would. */
const streamed = () =>
  new Response("", { headers: { "content-type": "text/event-stream" } });

const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), radius: z.number() }),
  z.object({ kind: z.literal("square"), side: z.number() }),
]);

export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: {
        params: z.object({ id: z.coerce.number() }),
        response: { 200: User, 404: NotFound },
      },
      handler: () => ({
        id: 1,
        name: "Ada",
        role: "admin" as const,
        createdAt: new Date(),
        tags: [],
        links: {},
        location: null,
        range: [1] as [number],
      }),
    }),
    route({
      method: "GET",
      path: "/users",
      schema: {
        query: z.object({
          page: z.coerce.number().optional(),
          since: z.coerce.date().optional(),
          role: z.enum(["admin", "user"]).optional(),
        }),
        headers: z.object({ authorization: z.string() }),
        response: z.array(User),
      },
      handler: () => [],
    }),
    route({
      method: "POST",
      path: "/users",
      schema: {
        body: z.object({
          name: z.string(),
          role: z.enum(["admin", "user"]).default("user"),
        }),
        response: { 201: User, 409: Problem, "4XX": Problem },
      },
      handler: (ctx) => {
        ctx.out.status = 201;

        return {
          id: 1,
          name: ctx.body.name,
          role: ctx.body.role,
          createdAt: new Date(),
          tags: [],
          links: {},
          location: null,
          range: [1] as [number],
        };
      },
    }),
    route({
      method: "DELETE",
      path: "/users/:id",
      schema: {
        params: z.object({ id: z.coerce.number() }),
        response: { 204: null, default: Problem },
      },
      handler: () => undefined,
    }),
    route({
      method: "PUT",
      path: "/users/:id/owners",
      schema: {
        body: z.object({
          owners: z.map(z.string(), Owner),
          tags: z.set(z.string()),
          span: z.tuple([z.date(), z.date().optional()]),
        }),
      },
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/categories",
      schema: { response: Category },
      handler: () => ({ name: "root", children: [] }),
    }),
    route({
      method: "GET",
      path: "/shapes/:id",
      schema: { response: { 200: Shape, "5XX": Problem } },
      handler: () => ({ kind: "circle" as const, radius: 1 }),
    }),
    route({
      method: "POST",
      path: "/uploads",
      bodyType: "form",
      schema: {
        body: z.object({
          title: z.string(),
          size: z.coerce.number(),
          file: z.file(),
        }),
        response: { 201: null },
      },
      handler: (ctx) => {
        ctx.out.status = 201;
      },
    }),
    route({
      method: "POST",
      path: "/notes",
      bodyType: "text",
      handler: () => "ok",
    }),
    route({
      method: "PUT",
      path: "/blobs/:id",
      bodyType: "stream",
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/export",
      schema: {
        response: {
          200: { contentType: "text/csv", body: z.string() },
        },
      },
      handler: () =>
        new Response("a,b", { headers: { "content-type": "text/csv" } }),
    }),
    route({
      method: "POST",
      path: "/agents/:name/stream",
      schema: {
        body: z.object({ input: z.string() }),
        headers: z.object({ authorization: z.string() }),
        response: {
          200: { contentType: "text/event-stream", body: Step },
          404: NotFound,
        },
      },
      handler: streamed,
    }),
    route({
      method: "GET",
      path: "/tokens",
      schema: {
        response: {
          200: { contentType: "text/event-stream", body: z.string() },
        },
      },
      handler: streamed,
    }),
    route({
      method: "GET",
      path: "/ticks",
      schema: { response: { 200: { contentType: "text/event-stream" } } },
      handler: streamed,
    }),
    route({
      method: "GET",
      path: "/pages/:page",
      schema: { params: z.object({ page: z.coerce.number().default(1) }) },
      handler: () => "ok",
    }),
    route({ method: "GET", path: "/files/*", handler: () => "ok" }),
    route({
      method: "GET",
      path: "/orgs/:org/members/:member-id",
      handler: () => "ok",
    }),
    route({ method: "GET", path: "/health", handler: () => "ok" }),
  ],
});
