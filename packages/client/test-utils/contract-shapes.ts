/**
 * Applications whose contracts test the printer's edges: brands it strips,
 * an application under another export and name, one a function builds,
 * shapes it writes its own way, and types it cannot write.
 * Compiled by the generator, never run.
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { z } from "zod";
import { mockSchema } from "../../core/test-utils/mock-schema.ts";
// @ts-expect-error a module that is not there, for a type that does not resolve
import type { Missing } from "./missing.ts";

const UserId = z.string().brand<"UserId">();

export const branded = createApp({
  routes: [
    route({
      method: "GET",
      path: "/accounts/:id",
      schema: {
        params: z.object({ id: z.coerce.number().brand<"AccountId">() }),
        response: z.object({ id: UserId, owner: UserId.nullable() }),
      },
      handler: () => ({
        id: UserId.parse("u"),
        owner: null,
      }),
    }),
  ],
});

export default createApp({
  routes: [route({ method: "GET", path: "/health", handler: () => "ok" })],
});

interface File {
  name: string;
  children: File[];
}

const Folder: z.ZodType<File, File> = z.object({
  name: z.string(),
  children: z.lazy(() => z.array(Folder)),
});

export const shadowing = createApp({
  routes: [
    route({
      method: "POST",
      path: "/folders",
      bodyType: "form",
      schema: {
        body: z.object({ upload: z.instanceof(globalThis.File) }),
        response: Folder,
      },
      handler: () => ({ name: "root", children: [] }),
    }),
  ],
});

/** The layout the guide suggests: the application built in a function, from its dependencies. */
export function buildApp(greeting: string) {
  return createApp({
    routes: [
      route({ method: "GET", path: "/greeting", handler: () => greeting }),
    ],
  });
}

/** The same, built once something is awaited. */
export async function buildLater(greeting: Promise<string>) {
  const text = await greeting;

  return createApp({
    routes: [route({ method: "GET", path: "/later", handler: () => text })],
  });
}

type Kind = "user" | "team";

interface Tag {
  readonly tag: "tag";
}

interface Keyed {
  key: `${Kind}_${string & Tag}`;
  shout: Uppercase<string>;
  quoted: `a\`\${b}${number}`;
}

const Topic = z.object({
  name: z.string(),
  get children() {
    return z.array(Topic);
  },
});

export const written = createApp({
  routes: [
    route({
      method: "POST",
      path: "/topics",
      schema: {
        body: Topic,
        response: z.object({
          meta: z.any(),
          key: z.templateLiteral(["user_", z.string().brand<"Uid">()]),
          list: z.array(z.object({}).nullable()),
          extra: z.object({ a: z.string() }).catchall(z.number()),
        }),
      },
      handler: () => undefined as never,
    }),
    route({
      method: "GET",
      path: "/keys",
      schema: { response: mockSchema<Keyed, Keyed>() },
      handler: () => undefined as never,
    }),
  ],
});

export const notAnApp = { routes: [] };

export const notABuilder = () => ({ routes: [] });

interface Callback {
  onDone: () => void;
}

interface Handlers {
  handlers: Set<() => void>;
}

interface Tagged {
  tag: symbol;
}

interface Rewrite {
  rewriter: HTMLRewriter;
}

interface Unresolved {
  value: Missing;
}

interface Reply {
  user: Unresolved;
}

export const unwritable = createApp({
  routes: [
    route({
      method: "POST",
      path: "/callbacks",
      schema: { body: mockSchema<Callback, Callback>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/handlers",
      schema: { body: mockSchema<Handlers, Handlers>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/symbols",
      schema: { body: mockSchema<Tagged, Tagged>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/rewrites",
      schema: { body: mockSchema<Rewrite, Rewrite>() },
      handler: () => "ok",
    }),
    route({
      method: "POST",
      path: "/missing",
      schema: { body: mockSchema<Unresolved, Unresolved>() },
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/replies",
      schema: { response: mockSchema<Reply, Reply>() },
      handler: () => undefined as never,
    }),
  ],
});
