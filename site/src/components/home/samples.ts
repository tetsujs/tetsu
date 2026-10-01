const cut = "// ---cut---";

const domain = [
  "interface User { id: number; name: string; email: string }",
  "interface Order { id: number; owner: number; shipped: boolean }",
  "interface UserRepository { find(id: number): User | undefined; create(input: { name: string; email: string }): User }",
  "interface OrderService { find(id: number): Order | undefined; listFor(user: number): Order[]; cancel(order: Order): Order }",
  "interface Sessions { verify(token: string | null): Promise<User | undefined> }",
  "declare const repo: UserRepository;",
  "declare const orders: OrderService;",
  "declare const sessions: Sessions;",
];

const usersController = [
  'const usersController = controller("Users", (users: UserRepository) => ({',
  '  get: route({ method: "GET", path: "/users/:id", handler: (ctx) => users.find(Number(ctx.params.id)) }),',
  "}));",
];

const code = (setup: string[], lines: string[]) =>
  [...setup, cut, ...lines].join("\n");

export const caught = [
  {
    label: "Hook without its user",
    code: code(
      [
        'import type { Requires } from "@tetsujs/core";',
        'import { hook, route } from "@tetsujs/core";',
        ...domain,
      ],
      [
        "const latestOrder = hook.beforeHandle(",
        "  (ctx: Requires<{ user: User }>) => ({ order: orders.listFor(ctx.user.id)[0] }),",
        ");",
        "",
        "// @errors: 2322",
        "route({",
        '  method: "GET",',
        '  path: "/orders/latest",',
        "  hooks: { beforeHandle: [latestOrder] },",
        "  handler: (ctx) => ctx.order,",
        "});",
      ],
    ),
  },
  {
    label: "Undeclared status",
    code: code(
      [
        'import { route } from "@tetsujs/core";',
        'import { z } from "zod";',
        ...domain,
      ],
      [
        "const UserDto = z.object({ id: z.number(), name: z.string() });",
        "",
        "// @errors: 2322",
        "route({",
        '  method: "POST",',
        '  path: "/users",',
        "  schema: { response: { 200: UserDto } },",
        "  handler: (ctx) => {",
        "    ctx.out.status = 201;",
        '    return repo.create({ name: "Ada", email: "ada@example.com" });',
        "  },",
        "});",
      ],
    ),
  },
  {
    label: "Path Bun never matches",
    code: code(
      ['import { route } from "@tetsujs/core";'],
      [
        "// @errors: 2322",
        "route({",
        '  method: "GET",',
        '  path: "/files/*/raw",',
        '  handler: () => new Response("…"),',
        "});",
      ],
    ),
  },
];

export const tabs = [
  {
    label: "Routes and validation",
    text: "The body is read and checked before the handler runs. A failure is a 422 with the issues; ctx.body is what the schema returned.",
    code: code(
      [
        'import { route } from "@tetsujs/core";',
        'import { z } from "zod";',
        ...domain,
      ],
      [
        "const UserDto = z.object({ id: z.number(), name: z.string() });",
        "",
        "export const createUser = route({",
        '  method: "POST",',
        '  path: "/users",',
        "  schema: {",
        "    body: z.object({ name: z.string().min(1), email: z.email() }),",
        "    response: { 201: UserDto },",
        "  },",
        "  handler: (ctx) => {",
        "    ctx.out.status = 201;",
        "    return repo.create(ctx.body);",
        "  },",
        "});",
      ],
    ),
  },
  {
    label: "Hooks",
    text: "Hooks sit in fixed slots of the request, not in an onion. What a hook returns joins ctx, typed in everything after it.",
    code: code(
      ['import { hook, HttpError, route } from "@tetsujs/core";', ...domain],
      [
        "const auth = hook.beforeParse(async (ctx) => {",
        '  const user = await sessions.verify(ctx.req.headers.get("authorization"));',
        "  if (!user) throw new HttpError(401);",
        "  return { user };",
        "});",
        "",
        "const log = hook.afterResponse((ctx) => {",
        "  console.log(ctx.req.method, ctx.route?.path, ctx.res.status);",
        "});",
        "",
        "export const listOrders = route({",
        '  method: "GET",',
        '  path: "/orders",',
        "  hooks: { beforeParse: [auth], afterResponse: [log] },",
        "  handler: (ctx) => orders.listFor(ctx.user.id),",
        "});",
      ],
    ),
  },
  {
    label: "Controllers",
    text: "A controller is a name and a function from its dependencies to its routes. The application is wired by hand, in one place.",
    code: code(
      [
        'import { controller, createApp, route } from "@tetsujs/core";',
        ...domain,
      ],
      [
        'export const ordersController = controller("Orders", (orders: OrderService) => ({',
        "  list: route({",
        '    method: "GET",',
        '    path: "/orders",',
        "    handler: () => orders.listFor(1),",
        "  }),",
        "}));",
        "",
        'export const usersController = controller("Users", (users: UserRepository) => ({',
        "  get: route({",
        '    method: "GET",',
        '    path: "/users/:id",',
        "    handler: (ctx) => users.find(Number(ctx.params.id)),",
        "  }),",
        "}));",
        "",
        "export default createApp({",
        "  routes: [ordersController(orders), usersController(repo)],",
        "});",
      ],
    ),
  },
  {
    label: "Errors",
    text: "Your errors, failed validation, 404 and 405 all leave in one envelope. An onError hook on the application can replace it everywhere.",
    code: code(
      [
        'import { httpError, HttpError, route } from "@tetsujs/core";',
        'import { z } from "zod";',
        ...domain,
      ],
      [
        "export const cancelOrder = route({",
        '  method: "POST",',
        '  path: "/orders/:id/cancel",',
        "  schema: { params: z.object({ id: z.coerce.number() }) },",
        "  handler: (ctx) => {",
        "    const order = orders.find(ctx.params.id);",
        "    if (!order) throw new HttpError(404);",
        '    if (order.shipped) throw httpError(409, "ALREADY_SHIPPED", "Order already shipped");',
        "    return orders.cancel(order);",
        "  },",
        "});",
        "",
        '// 404 { "status": 404, "message": "Not Found", "error": "NOT_FOUND" }',
        '// 409 { "status": 409, "message": "Order already shipped", "error": "ALREADY_SHIPPED" }',
      ],
    ),
  },
  {
    label: "OpenAPI",
    text: "The document is built once, at startup, from the routes you already declared: their schemas, their responses and the guards you annotated.",
    code: code(
      [
        'import { controller, createApp, route } from "@tetsujs/core";',
        ...domain,
        ...usersController,
      ],
      [
        'import { docs } from "@tetsujs/openapi";',
        "",
        "export default createApp({",
        "  routes: [",
        "    usersController(repo),",
        '    docs({ info: { title: "Users API", version: "1.0.0" } }),',
        "  ],",
        "});",
        "",
        "// GET /openapi.json — the document",
        "// GET /docs         — the page",
      ],
    ),
  },
  {
    label: "Testing",
    text: "A handler is a function: call it with a context. The whole application is served on a free port, through Bun's own router.",
    code: code(
      [
        'import { controller, createApp, route } from "@tetsujs/core";',
        ...domain,
        "declare const ada: User;",
        ...usersController,
      ],
      [
        'import { serve, testCtx } from "@tetsujs/core/testing";',
        'import { expect, test } from "bun:test";',
        "",
        "const request = serve(createApp({ routes: usersController(repo) }));",
        "",
        'test("the handler, alone", () => {',
        "  const { get } = usersController(repo);",
        '  expect(get.handler(testCtx({ params: { id: "1" } }))).toEqual(ada);',
        "});",
        "",
        'test("the application, over HTTP", async () => {',
        '  expect((await request("/users/1")).status).toBe(200);',
        "});",
      ],
    ),
  },
];
