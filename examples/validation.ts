/**
 * Validating the path, the query and the body with Zod.
 *
 * Each part a schema covers is typed from the schema's output — `id` and
 * `page` arrive as numbers — and a part that fails is a `422` listing
 * every issue, before the handler runs.
 *
 * ```sh
 * bun examples/validation.ts
 * curl localhost:3000/items?page=1
 * curl localhost:3000/items/1
 * curl localhost:3000/items/x          # 422, params.id
 * curl -X POST localhost:3000/items -H 'content-type: application/json' \
 *   -d '{"name":"pen","qty":3}'
 * curl -X POST localhost:3000/items -H 'content-type: application/json' \
 *   -d '{"name":""}'                   # 422, body.name and body.qty
 * ```
 *
 * @module
 */

import { controller, createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const ItemId = z.object({ id: z.coerce.number().int().positive() });

const Page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

const NewItem = z.object({
  name: z.string().min(1),
  qty: z.number().int().min(1),
});

interface Item {
  readonly id: number;
  readonly name: string;
  readonly qty: number;
}

const itemsController = controller("Items", () => {
  const items: Item[] = [{ id: 1, name: "pen", qty: 3 }];

  return {
    list: route({
      method: "GET",
      path: "/items",
      schema: { query: Page },
      handler: (ctx) => {
        const { page, size } = ctx.query;

        return items.slice((page - 1) * size, page * size);
      },
    }),

    get: route({
      method: "GET",
      path: "/items/:id",
      schema: { params: ItemId },
      handler: (ctx) => {
        const item = items.find((candidate) => candidate.id === ctx.params.id);

        if (!item) {
          throw httpError(404, "ITEM_NOT_FOUND");
        }

        return item;
      },
    }),

    create: route({
      method: "POST",
      path: "/items",
      schema: { body: NewItem },
      handler: (ctx) => {
        const item = { id: items.length + 1, ...ctx.body };

        items.push(item);
        ctx.out.status = 201;

        return item;
      },
    }),
  };
});

export default createApp({ routes: itemsController() });
