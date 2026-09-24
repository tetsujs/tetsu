/**
 * Type-level tests for route definition — the integration surface of the
 * core. Ports the full spike test suite.
 *
 * @module
 */

import { testCtx } from "../test-utils/ctx.ts";
import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type {
  DeclaredStatus,
  FormBody,
  FormValue,
  Requires,
  SchemaConfig,
} from "./context.ts";
import { HttpError } from "./error.ts";
import { hook } from "./hook.ts";
import type { HandlerResult, ResultError, ValidateResult } from "./route.ts";
import { route } from "./route.ts";
import type { HooksConfig } from "./stack.ts";

declare function expectType<T>(value: T): void;

interface User {
  id: string;
  role: "admin" | "user";
}

declare function verifyToken(header: string | null): Promise<User | null>;

const CreateOrder = mockSchema<{ productId: string; qty: number }>();

const Order = mockSchema<{ id: string; status: "active" | "cancelled" }>();

const auth = hook.beforeParse(async (ctx) => {
  const user = await verifyToken(ctx.req.headers.get("authorization"));
  if (!user) throw new HttpError(401);
  return { user };
});

const withOrder = hook.beforeHandle(
  async (ctx: Requires<{ params: { id: string }; user: User }>) => ({
    order: { id: ctx.params.id, ownerId: ctx.user.id },
  }),
);

route({
  method: "GET",
  path: "/orders/:orderId/items/:itemId",
  handler: (ctx) => {
    expectType<string>(ctx.params.orderId);
    expectType<string>(ctx.params.itemId);
    // @ts-expect-error the path declares no such parameter
    ctx.params.nope;
  },
});

route({
  method: "POST",
  path: "/orders",
  schema: { body: CreateOrder },
  handler: (ctx) => {
    expectType<number>(ctx.body.qty);
    expectType<string>(ctx.body.productId);
  },
});

route({
  method: "GET",
  path: "/plain",
  handler: (ctx) => {
    // @ts-expect-error body does not exist without schema.body
    ctx.body;
    // @ts-expect-error query does not exist without schema.query
    ctx.query;
  },
});

route({
  method: "GET",
  path: "/me",
  hooks: { beforeParse: [auth] },
  handler: (ctx) => {
    expectType<User>(ctx.user);
    expectType<"admin" | "user">(ctx.user.role);
  },
});

route({
  method: "POST",
  path: "/orders/:id/cancel",
  hooks: {
    // @ts-expect-error withOrder requires ctx.user and no hook provides it
    beforeHandle: [withOrder],
  },
  handler: () => {},
});

const cancel = route({
  method: "POST",
  path: "/orders/:id/cancel",
  hooks: { beforeParse: [auth], beforeHandle: [withOrder] },
  schema: { response: Order },
  handler: (ctx) => {
    expectType<string>(ctx.order.ownerId);
    expectType<User>(ctx.user);

    return { id: ctx.order.id, status: "cancelled" as const };
  },
});

route({
  method: "GET",
  path: "/wrong-slot/:id",
  hooks: {
    // @ts-expect-error a beforeHandle hook cannot run in the beforeParse slot
    beforeParse: [withOrder],
  },
  handler: () => {},
});

route({
  method: "GET",
  path: "/orders/:id",
  schema: { response: Order },
  // @ts-expect-error "wrong" is not part of the response schema status union
  handler: () => ({ id: "1", status: "wrong" }),
});

route({
  method: "GET",
  path: "/inline",
  hooks: { beforeParse: [hook.beforeParse(() => ({ traceId: "t" }))] },
  handler: (ctx) => {
    expectType<string>(ctx.traceId);
  },
});

route({
  method: "GET",
  // @ts-expect-error route paths must start with "/"
  path: "orders",
  handler: () => {},
});

route({
  method: "GET",
  // @ts-expect-error route paths must not contain empty segments
  path: "/a//b",
  handler: () => {},
});

route({
  method: "GET",
  // @ts-expect-error route paths must not end with "/"
  path: "/orders/",
  handler: () => {},
});

route({
  method: "GET",
  path: "/",
  handler: () => {},
});

export type routeDefCases = [
  Expect<Equal<typeof cancel.path, "/orders/:id/cancel">>,
  Expect<Equal<typeof cancel.method, "POST">>,
  Expect<Equal<Parameters<typeof cancel.handler>[0]["user"], User>>,
  Expect<Equal<Parameters<typeof cancel.handler>[0]["params"], { id: string }>>,
];

const optionalAudit = hook.afterResponse(
  (ctx: Requires<{ res: Response; user?: User }>) => {
    void ctx.user?.id;
  },
);

const demandingAudit = hook.afterResponse(
  (ctx: Requires<{ res: Response; user: User }>) => {
    void ctx.user.id;
  },
);

route({
  method: "GET",
  path: "/audited",
  hooks: { beforeParse: [auth], afterResponse: [optionalAudit] },
  handler: (ctx) => ({ by: ctx.user.id }),
});

route({
  method: "GET",
  path: "/audited-strict",
  hooks: {
    beforeParse: [auth],
    // @ts-expect-error response slots may run before auth did, so the
    // extension can only be required as optional
    afterResponse: [demandingAudit],
  },
  handler: (ctx) => ({ by: ctx.user.id }),
});

route({
  method: "GET",
  // @ts-expect-error a parameter must span a whole segment
  path: "/a/:b-:c",
  handler: () => {},
});

route({
  method: "GET",
  // @ts-expect-error a colon inside a segment declares a surprising parameter
  path: "/rpc/foo:bar",
  handler: () => {},
});

route({
  method: "GET",
  path: "/files/*",
  handler: () => {},
});

route({
  method: "GET",
  path: "/bare-annotated",
  hooks: {
    // @ts-expect-error a bare function must be wrapped with hook.beforeParse(...)
    beforeParse: [(_ctx: unknown) => ({ user: { id: "1" } })],
  },
  handler: () => ({ ok: true }),
});

route({
  method: "GET",
  path: "/bare-unannotated",
  hooks: {
    // @ts-expect-error a bare function must be wrapped with hook.beforeParse(...)
    beforeParse: [(_ctx) => ({ user: { id: "1" } })],
  },
  handler: () => ({ ok: true }),
});

route({
  method: "GET",
  path: "/bare-response-slot",
  hooks: {
    // @ts-expect-error a bare function must be wrapped with hook.beforeResponse(...)
    beforeResponse: [() => undefined],
  },
  handler: () => ({ ok: true }),
});

const shared = [hook.beforeParse(() => ({ user: { id: "1" } }))];

route({
  method: "GET",
  path: "/widened-array",
  hooks: {
    // @ts-expect-error a widened array has no element types left to check
    beforeParse: shared,
  },
  handler: () => ({ ok: true }),
});

const annotated: HooksConfig = {
  beforeParse: [hook.beforeParse(() => ({ user: { id: "1" } }))],
};

route({
  method: "GET",
  path: "/annotated-config",
  // @ts-expect-error a HooksConfig annotation widens every slot to an array
  hooks: annotated,
  handler: () => ({ ok: true }),
});

const tail = [hook.beforeParse(() => ({ role: "admin" }))];

route({
  method: "GET",
  path: "/spread-tail",
  hooks: {
    // @ts-expect-error spreading a widened array leaves an unchecked rest element
    beforeParse: [hook.beforeParse(() => ({ user: { id: "1" } })), ...tail],
  },
  handler: () => ({ ok: true }),
});

const asConst = [hook.beforeParse(() => ({ user: { id: "1" } }))] as const;

route({
  method: "GET",
  path: "/as-const",
  hooks: { beforeParse: asConst },
  handler: (ctx) => ({ user: ctx.user.id }),
});

route({
  method: "GET",
  path: "/empty-slot",
  hooks: { beforeParse: [] },
  handler: () => ({ ok: true }),
});

const Quantity = mockSchema<{ qty: number }>();

const Page = mockSchema<{ page: number }>();

const normalizeBody = hook.beforeValidation(() => ({
  body: { qty: "7" },
}));

const normalizeQuery = hook.beforeParse(() => ({
  query: { page: "2" },
}));

const overrideAfterValidation = hook.beforeHandle(() => ({
  body: { qty: "late" },
}));

route({
  method: "POST",
  path: "/schema-wins-over-hook",
  schema: { body: Quantity, query: Page },
  hooks: { beforeParse: [normalizeQuery], beforeValidation: [normalizeBody] },
  handler: (ctx) => {
    expectType<number>(ctx.body.qty);
    expectType<number>(ctx.query.page);
    // @ts-expect-error validation overwrites the body a hook contributed
    expectType<string>(ctx.body.qty);
  },
});

route({
  method: "POST",
  path: "/hook-owns-undeclared-parts",
  hooks: { beforeParse: [normalizeQuery], beforeValidation: [normalizeBody] },
  handler: (ctx) => {
    expectType<string>(ctx.body.qty);
    expectType<string>(ctx.query.page);
  },
});

route({
  method: "POST",
  path: "/before-handle-still-wins",
  schema: { body: Quantity },
  hooks: { beforeHandle: [overrideAfterValidation] },
  handler: (ctx) => {
    expectType<string>(ctx.body.qty);
  },
});

const contributesBody = hook.beforeParse(() => ({ body: { qty: "7" } }));

const needsHookBody = hook.beforeValidation(
  (ctx: Requires<{ body: { qty: string } }>) => {
    void ctx.body.qty;
  },
);

route({
  method: "POST",
  path: "/parsed-body-overwrites-hook",
  schema: { body: Quantity },
  hooks: {
    beforeParse: [contributesBody],
    // @ts-expect-error parseBody overwrites the body a beforeParse hook contributed
    beforeValidation: [needsHookBody],
  },
  handler: () => ({ ok: true }),
});

route({
  method: "POST",
  path: "/hook-body-survives-without-schema",
  hooks: {
    beforeParse: [contributesBody],
    beforeValidation: [needsHookBody],
  },
  handler: () => ({ ok: true }),
});

route({
  method: "POST",
  path: "/form-typed",
  bodyType: "form",
  handler: (ctx) => {
    const field: string = "anything";

    expectType<FormValue | FormValue[] | undefined>(ctx.body[field]);
    // @ts-expect-error a form field is not known to be a string
    expectType<string>(ctx.body.title);
    return { ok: true };
  },
});

route({
  method: "POST",
  path: "/text-typed",
  bodyType: "text",
  handler: (ctx) => {
    expectType<string>(ctx.body);
    return { length: ctx.body.length };
  },
});

route({
  method: "POST",
  path: "/json-typed",
  bodyType: "json",
  handler: (ctx) => {
    expectType<unknown>(ctx.body);
    // @ts-expect-error an unvalidated JSON body is unknown, not an object
    ctx.body.field;
    return { ok: true };
  },
});

route({
  method: "POST",
  path: "/no-body-declared",
  handler: (ctx) => {
    // @ts-expect-error the body is never read, so it is not in the context
    ctx.body;
    return { ok: true };
  },
});

const FormFields = mockSchema<{ title: string; avatar: File }>();

route({
  method: "POST",
  path: "/form-schema",
  bodyType: "form",
  schema: { body: FormFields },
  handler: (ctx) => {
    expectType<string>(ctx.body.title);
    expectType<File>(ctx.body.avatar);
    return { ok: true };
  },
});

const seesRawForm = hook.beforeValidation(
  (ctx: Requires<{ body: FormBody }>) => {
    void ctx.body;
  },
);

route({
  method: "POST",
  path: "/form-hook",
  bodyType: "form",
  schema: { body: FormFields },
  hooks: { beforeValidation: [seesRawForm] },
  handler: () => ({ ok: true }),
});

const seesString = hook.beforeValidation((ctx: Requires<{ body: string }>) => {
  void ctx.body;
});

route({
  method: "POST",
  path: "/form-hook-wrong",
  bodyType: "form",
  hooks: {
    // @ts-expect-error a form body is not a string before validation
    beforeValidation: [seesString],
  },
  handler: () => ({ ok: true }),
});

const Session = mockSchema<{ token: string }>();
const CreatedSession = mockSchema<{ id: number }>();
const AuthError = mockSchema<{ code: "auth_code_invalid" }>();

route({
  method: "POST",
  path: "/session",
  schema: { response: { 200: Session, 201: CreatedSession, 422: AuthError } },
  handler: () => ({ token: "t" }),
});

route({
  method: "POST",
  path: "/session-created",
  schema: { response: { 200: Session, 201: CreatedSession } },
  handler: (ctx) => {
    ctx.out.status = 201;

    return { id: 7 };
  },
});

route({
  method: "POST",
  path: "/session-error-shape",
  schema: { response: { 200: Session, 422: AuthError } },
  handler: (ctx) => {
    ctx.out.status = 422;

    return { code: "auth_code_invalid" as const };
  },
});

route({
  method: "POST",
  path: "/session-raw",
  schema: { response: { 200: Session } },
  handler: () => Response.json({ token: "t" }),
});

route({
  method: "DELETE",
  path: "/session-empty",
  schema: { response: { 204: null } },
  handler: (ctx) => {
    ctx.out.headers.set("x-revoked", "1");
  },
});

route({
  method: "DELETE",
  path: "/session-empty-explicit",
  schema: { response: { 204: null } },
  handler: () => undefined,
});

route({
  method: "DELETE",
  path: "/session-empty-or-shape",
  schema: { response: { 200: Session, 204: null } },
  handler: (ctx) => (ctx.req.url ? { token: "t" } : undefined),
});

route({
  method: "DELETE",
  path: "/session-body-required",
  schema: { response: { 200: Session } },
  // @ts-expect-error nothing is not one of the declared shapes
  handler: async () => {},
});

route({
  method: "POST",
  path: "/session-undeclared",
  schema: { response: { 200: Session, 422: AuthError } },
  // @ts-expect-error a shape no entry declares is not a valid return
  handler: () => ({ nothing: "like it" }),
});

route({
  method: "POST",
  path: "/session-undeclared-async",
  schema: { response: { 200: Session, 422: AuthError } },
  // @ts-expect-error awaiting does not make an undeclared shape declared
  handler: async () => ({ nothing: "like it" }),
});

route({
  method: "POST",
  path: "/session-undeclared-status",
  schema: { response: { 200: Session } },
  handler: (ctx) => {
    // @ts-expect-error a status the map does not declare cannot be set
    ctx.out.status = 201;

    return { token: "t" };
  },
});

route({
  method: "POST",
  path: "/session-declared-status",
  schema: { response: { 201: CreatedSession, 422: AuthError, 204: null } },
  handler: (ctx) => {
    ctx.out.status = 201;
    ctx.out.status = 204;
    ctx.out.status = undefined;

    expectType<number | undefined>(ctx.out.status);

    return { id: 7 };
  },
});

route({
  method: "POST",
  path: "/session-single-schema-status",
  schema: { response: Session },
  handler: (ctx) => {
    ctx.out.status = 418;

    return { token: "t" };
  },
});

route({
  method: "POST",
  path: "/session-no-contract-status",
  handler: (ctx) => {
    ctx.out.status = 418;

    return { anything: true };
  },
});

const mapped = route({
  method: "POST",
  path: "/session-unit-tested",
  schema: { response: { 201: CreatedSession } },
  handler: (ctx) => {
    ctx.out.status = 201;

    return { id: 7 };
  },
});

mapped.handler(testCtx({ params: {} }));

const asyncMapped = route({
  method: "GET",
  path: "/session-async-unit-tested",
  schema: { response: { 200: Session, 404: AuthError } },
  handler: async (ctx) =>
    ctx.req.headers.has("x-raw")
      ? new Response(null, { status: 404 })
      : { token: "t" },
});

const untyped = route({
  method: "GET",
  path: "/session-untyped",
  handler: () => ({ anything: 1 }),
});

/**
 * A route keeps what its handler was inferred to return, so a unit test
 * calling `handler(testCtx(…))` gets that type rather than every shape the
 * route's contract allows — `{ id: number }`, not `{ id: number } |
 * Response`, which each test would have to narrow before reading a field.
 */
export type handlerReturnCases = [
  Expect<Equal<ReturnType<typeof mapped.handler>, { id: number }>>,
  Expect<
    Equal<
      Awaited<ReturnType<typeof asyncMapped.handler>>,
      Response | { token: string }
    >
  >,
  Expect<Equal<ReturnType<typeof untyped.handler>, { anything: number }>>,
];

/**
 * The statuses a map declares are what the handler may write, and the
 * handler only — hooks do not know their route, so a status they set is
 * refused at runtime instead. Reading stays a number: a hook may already
 * have written something else, and the type says so rather than hide it.
 * Narrowing the write and not the read is also what keeps `testCtx()`,
 * whose `out` is an ordinary `Outgoing`, a valid argument.
 */
export type declaredStatusCases = [
  Expect<
    Equal<
      DeclaredStatus<{ response: { 201: typeof CreatedSession; 204: null } }>,
      201 | 204
    >
  >,
  Expect<Equal<DeclaredStatus<{ response: typeof Session }>, never>>,
  Expect<Equal<DeclaredStatus<SchemaConfig>, never>>,
  Expect<Equal<DeclaredStatus<{ body: typeof Session }>, never>>,
];

type MapResult = HandlerResult<{
  response: { 200: typeof Session; 422: typeof AuthError };
}>;

export type responseMapCases = [
  Expect<
    Equal<
      Exclude<MapResult, Response>,
      { token: string } | { code: "auth_code_invalid" }
    >
  >,
  Expect<
    Equal<
      Exclude<HandlerResult<{ response: typeof Session }>, Response>,
      { token: string }
    >
  >,
];

route({
  method: "GET",
  path: "/bare-stream",
  // @ts-expect-error a stream serializes to "{}"; it belongs inside a Response
  handler: () => new ReadableStream<Uint8Array>(),
});

route({
  method: "GET",
  path: "/bare-async-generator",
  // @ts-expect-error an async generator serializes to "{}" just as quietly
  handler: async function* () {
    yield "chunk";
  },
});

route({
  method: "GET",
  path: "/bare-generator",
  // @ts-expect-error a synchronous generator is the same defect
  handler: function* () {
    yield "chunk";
  },
});

route({
  method: "GET",
  path: "/sometimes-a-stream",
  // @ts-expect-error a handler that can return a stream on one branch does
  handler: (): ReadableStream | { id: number } => ({ id: 1 }),
});

route({ method: "GET", path: "/list", handler: () => [1, 2, 3] });

route({ method: "GET", path: "/pairs", handler: () => new Map([["a", 1]]) });

route({
  method: "GET",
  path: "/wrapped",
  handler: () => new Response(new ReadableStream<Uint8Array>()),
});

route({ method: "GET", path: "/opaque", handler: (): unknown => "anything" });

export type resultCases = [
  Expect<Equal<ValidateResult<{ id: number }>, unknown>>,
  Expect<Equal<ValidateResult<Response>, unknown>>,
  Expect<Equal<ValidateResult<readonly number[]>, unknown>>,
  Expect<Equal<ValidateResult<unknown>, unknown>>,
  Expect<Equal<ValidateResult<ReadableStream>, ResultError<StreamRefusal>>>,
  Expect<
    Equal<
      ValidateResult<Promise<AsyncGenerator<string>>>,
      ResultError<StreamRefusal>
    >
  >,
];

type StreamRefusal =
  "A handler must not return a stream: it serializes to '{}' and the body is silently dropped. Wrap it in the response it belongs to — new Response(stream, { headers }) — or serve it as events with sse() from @tetsujs/sse";

route({
  method: "POST",
  path: "/upload",
  bodyType: "stream",
  handler: async (ctx) => {
    for await (const chunk of ctx.body) {
      expectType<Uint8Array>(chunk);
    }
  },
});

route({
  method: "POST",
  path: "/upload-with-a-schema",
  // @ts-expect-error a stream has nothing for a validator to see
  bodyType: "stream",
  schema: { body: CreateOrder },
  handler: () => ({ ok: true }),
});

route({
  method: "POST",
  path: "/upload-capped",
  bodyType: "stream",
  maxBodySize: 5_000_000,
  handler: () => ({ ok: true }),
});
