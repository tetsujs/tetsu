/**
 * An OpenAPI 3.1 document and a page to read it, from the routes as they
 * are.
 *
 * `docs()` is a controller: mounted with the rest, it serves the document
 * at `/openapi.json` and a reference page at `/docs`. Paths, parameters,
 * bodies and responses come from the schemas — Zod emits JSON Schema
 * itself — `docs` on a route adds the prose, and `secured()` tells the
 * document what a hook enforces.
 *
 * ```sh
 * bun examples/openapi.ts
 * open http://localhost:3000/docs
 * curl localhost:3000/openapi.json
 * ```
 *
 * @module
 */

import {
  controller,
  createApp,
  group,
  HttpError,
  hook,
  httpError,
  route,
} from "@tetsujs/core";
import { docs, secured } from "@tetsujs/openapi";
import { z } from "zod";

const bearer = secured(
  hook.beforeParse((ctx) => {
    if (ctx.req.headers.get("authorization") !== "Bearer secret") {
      throw new HttpError(401);
    }
  }),
  {
    name: "bearer",
    scheme: { type: "http", scheme: "bearer" },
    description: "Missing or invalid token",
    error: "UNAUTHORIZED",
  },
);

const BookId = z.object({ id: z.coerce.number().int().positive() });

const Book = z.object({
  id: z.number().int(),
  title: z.string(),
  year: z.number().int().optional(),
});

const NewBook = Book.omit({ id: true });

const NotFound = z.object({
  status: z.literal(404),
  message: z.string(),
  error: z.string(),
});

const booksController = controller("Books", () => {
  const books = new Map<number, z.infer<typeof Book>>([
    [1, { id: 1, title: "SICP", year: 1985 }],
  ]);

  return {
    get: route({
      method: "GET",
      path: "/books/:id",
      schema: { params: BookId, response: { 200: Book, 404: NotFound } },
      docs: { summary: "Get a book", tags: ["books"] },
      handler: (ctx) => {
        const book = books.get(ctx.params.id);

        if (!book) {
          throw httpError(404, "BOOK_NOT_FOUND");
        }

        return book;
      },
    }),

    create: route({
      method: "POST",
      path: "/books",
      schema: { body: NewBook, response: { 201: Book } },
      hooks: { beforeParse: [bearer] },
      docs: { summary: "Add a book", tags: ["books"] },
      handler: (ctx) => {
        const book = { id: books.size + 1, ...ctx.body };

        books.set(book.id, book);
        ctx.out.status = 201;

        return book;
      },
    }),
  };
});

export default createApp({
  routes: [
    group("/api", { children: [booksController()] }),
    docs({ info: { title: "Books", version: "1.0.0" } }),
  ],
});
