/**
 * Type-level tests of the client: what a call of each kind of route takes,
 * and what its result says, read off `typeof app` and off a contract.
 *
 * The schemas are mocks with an input and an output of their own, the way
 * a coercing or transforming validator has them, so each test says which
 * of the two the client chose.
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { mockSchema } from "../../core/test-utils/mock-schema.ts";
import type { Equal, Expect } from "../../core/test-utils/types.ts";
import type {
  Client,
  ClientError,
  ClientTypes,
  ContractOf,
  ErrorBody,
  Failure,
  Jsonify,
  Raw,
  ServerErrorStatus,
  Success,
  SuccessStatus,
  ValidationIssue,
} from "./index.ts";
import { createClient, unwrap } from "./index.ts";

/** Holds `T` to be `true` where a type alias would go unused: in a narrowed branch. */
declare function check<T extends true>(): void;

declare const userId: unique symbol;

type UserId = string & { readonly [userId]: true };

const Id = mockSchema<{ id: number }>();
const Page = mockSchema<{ page: number }, { page?: unknown }>();
const Search = mockSchema<
  { q: string; tags: string[] },
  { q: string; tags?: string[] }
>();
const Since = mockSchema<{ since: Date }, { since: unknown }>();
const Branded = mockSchema<{ id: UserId }, { id: string }>();
const Split = mockSchema<{ ids: string[] }, { ids: string }>();
const Auth = mockSchema<{ authorization: string }>();
const NewUser = mockSchema<
  { name: string; role: "admin" | "user" },
  { name: string; role?: "admin" | "user" }
>();
const Upload = mockSchema<
  { title: string; size: number; file: File },
  { title: string; size: unknown; file: File }
>();
const User = mockSchema<{
  id: UserId;
  name: string;
  createdAt: Date;
  note?: string | undefined;
  tags: Set<string>;
}>();
const NotFound = mockSchema<{
  status: 404;
  error: "USER_NOT_FOUND";
  message: string;
}>();
const Conflict = mockSchema<{
  status: 409;
  error: "NAME_TAKEN";
  message: string;
}>();
const Problem = mockSchema<{ title: string }>();
const Csv = mockSchema<string>();

declare const accountId: unique symbol;

type Branded<T> = T & { readonly [accountId]: true };

const Account = mockSchema<{ id: Branded<number> }>();
const Window = mockSchema<{ from: Branded<Date> }>();

const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: Id, response: { 200: User, 404: NotFound } },
      handler: () => ({
        id: "u" as UserId,
        name: "n",
        createdAt: new Date(),
        tags: new Set<string>(),
      }),
    }),
    route({
      method: "POST",
      path: "/users",
      schema: { body: NewUser, response: { 201: User, 409: Conflict } },
      handler: (ctx) => {
        ctx.out.status = 201;

        return {
          id: "u" as UserId,
          name: ctx.body.name,
          createdAt: new Date(),
          tags: new Set<string>(),
        };
      },
    }),
    route({
      method: "DELETE",
      path: "/users/:id",
      schema: { params: Id, response: { 204: null } },
      handler: () => undefined,
    }),
    route({
      method: "GET",
      path: "/users",
      schema: { query: Page, response: User },
      handler: () => ({
        id: "u" as UserId,
        name: "n",
        createdAt: new Date(),
        tags: new Set<string>(),
      }),
    }),
    route({
      method: "GET",
      path: "/search",
      schema: { query: Search },
      handler: () => "found",
    }),
    route({
      method: "GET",
      path: "/feed",
      schema: { query: Since, headers: Auth },
      handler: () => "feed",
    }),
    route({
      method: "GET",
      path: "/branded/:id",
      schema: { params: Branded },
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/split",
      schema: { query: Split },
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/orgs/:org/members/:member-id",
      handler: () => "ok",
    }),
    route({ method: "GET", path: "/files/*", handler: () => "ok" }),
    route({ method: "GET", path: "/health", handler: () => "ok" }),
    route({
      method: "POST",
      path: "/uploads",
      bodyType: "form",
      schema: { body: Upload, response: { 201: null } },
      handler: (ctx) => {
        ctx.out.status = 201;
      },
    }),
    route({
      method: "POST",
      path: "/forms",
      bodyType: "form",
      handler: () => "ok",
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
      method: "PATCH",
      path: "/raw",
      bodyType: "json",
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/export",
      schema: { response: { 200: { contentType: "text/csv", body: Csv } } },
      handler: () =>
        new Response("a,b", { headers: { "content-type": "text/csv" } }),
    }),
    route({
      method: "GET",
      path: "/ranged",
      schema: { response: { 200: Id, "4XX": Problem, default: NotFound } },
      handler: () => ({ id: 1 }),
    }),
    route({
      method: "GET",
      path: "/fallback",
      schema: { response: { 200: Id, default: Problem } },
      handler: () => ({ id: 1 }),
    }),
    route({
      method: "GET",
      path: "/teams/:team/members/:id",
      schema: { params: Id },
      handler: () => "ok",
    }),
    route({
      method: "GET",
      path: "/problems",
      schema: {
        response: {
          200: { contentType: "application/vnd.api+json", body: Id },
          404: { contentType: "application/problem+json", body: Problem },
        },
      },
      handler: () =>
        new Response("{}", {
          headers: { "content-type": "application/vnd.api+json" },
        }),
    }),
    route({ method: "POST", path: "/search", handler: () => "ok" }),
    route({
      method: "GET",
      path: "/accounts/:id",
      schema: { params: Account, query: Window },
      handler: () => "ok",
    }),
  ],
});

const api = createClient<typeof app>({ baseUrl: "https://api.example.com" });

type Api = ContractOf<typeof app>;

type JsonUser = {
  id: UserId;
  name: string;
  createdAt: string;
  note?: string;
  tags: Record<never, never>;
};

// --- What a call takes ------------------------------------------------------

export async function paths() {
  await api.get("/users/:id", { params: { id: 1 } });
  await api.post("/users", { body: { name: "n" } });

  // @ts-expect-error only GET routes are offered to get
  await api.get("/uploads");

  // @ts-expect-error a path no route has
  await api.post("/nowhere");

  // @ts-expect-error the path as the route declares it, not filled in
  await api.get("/users/1");
}

export async function params() {
  // @ts-expect-error a path with a parameter needs params
  await api.get("/users/:id");

  // @ts-expect-error a coercing schema takes unknown, so the client takes its output: a number
  await api.get("/users/:id", { params: { id: "1" } });

  await api.get("/orgs/:org/members/:member-id", {
    params: { org: 1, "member-id": "m" },
  });
  await api.get("/orgs/:org/members/:member-id", {
    params: { org: "o", "member-id": 7 },
  });

  // @ts-expect-error without a schema each parameter is text or a number, and all are needed
  await api.get("/orgs/:org/members/:member-id", { params: { org: "o" } });

  await api.get("/files/*", { params: { "*": "a/b.txt" } });

  // @ts-expect-error the rest of a wildcard path is needed
  await api.get("/files/*");

  // @ts-expect-error the rest of a path is text
  await api.get("/files/*", { params: { "*": 1 } });

  // @ts-expect-error a branded output is the server's to make: the client sends the input
  await api.get("/branded/:id", { params: { id: 1 } });
  await api.get("/branded/:id", { params: { id: "plain" } });

  // @ts-expect-error a path without parameters takes none
  await api.get("/health", { params: { id: 1 } });
}

export async function partialParams() {
  await api.get("/teams/:team/members/:id", { params: { team: "t", id: 7 } });

  // @ts-expect-error the schema names id alone, and the path still needs team
  await api.get("/teams/:team/members/:id", { params: { id: 7 } });

  await api.get("/teams/:team/members/:id", {
    // @ts-expect-error the schema's id is a number
    params: { team: "t", id: "7" },
  });
}

export async function coercedBrands() {
  await api.get("/accounts/:id", {
    params: { id: 42 },
    query: { from: new Date() },
  });
}

export async function query() {
  await api.get("/users");
  await api.get("/users", { query: { page: 2 } });

  // @ts-expect-error a coercing schema takes unknown, so the client takes its output
  await api.get("/users", { query: { page: "two" } });

  // @ts-expect-error q is required, so query is
  await api.get("/search");
  await api.get("/search", { query: { q: "x", tags: ["a", "b"] } });

  await api.get("/feed", {
    query: { since: new Date() },
    headers: { authorization: "Bearer t" },
  });

  // @ts-expect-error an irreversible transform: the client sends what it takes, a string
  await api.get("/split", { query: { ids: ["a"] } });
  await api.get("/split", { query: { ids: "a,b" } });

  // @ts-expect-error a route without a query schema takes no query
  await api.get("/health", { query: { page: 1 } });
}

export async function headers() {
  // @ts-expect-error the route requires authorization, so a call does
  await api.get("/feed", { query: { since: new Date() } });

  await api.get("/feed", {
    query: { since: new Date() },
    headers: {
      authorization: "Bearer t",
      "idempotency-key": "k",
      at: new Date(),
    },
  });

  await api.get("/feed", {
    query: { since: new Date() },
    // @ts-expect-error a header the route names has the schema's type
    headers: { authorization: 1 },
  });

  await api.get("/health", { headers: { "if-none-match": "x", retries: 2 } });

  // @ts-expect-error a header is text, a number, a boolean or a date
  await api.get("/health", { headers: { "x-object": { a: 1 } } });

  const signed = createClient<typeof app, { headers: "authorization" }>();

  await signed.get("/feed", { query: { since: new Date() } });
  await signed.get("/feed", {
    query: { since: new Date() },
    headers: { authorization: "Bearer other" },
  });

  const cased = createClient<typeof app, { headers: "Authorization" }>();

  await cased.get("/feed", { query: { since: new Date() } });

  const other = createClient<typeof app, { headers: "x-trace" }>();

  // @ts-expect-error the client sends x-trace, not authorization
  await other.get("/feed", { query: { since: new Date() } });
}

export async function bodies() {
  // @ts-expect-error a route with a body schema needs a body
  await api.post("/users");

  // @ts-expect-error the schema's input: role is optional, name is not
  await api.post("/users", { body: { role: "admin" } });

  // @ts-expect-error a route that takes a form takes it as form, not body
  await api.post("/uploads", { body: { title: "t" } });

  await api.post("/uploads", {
    form: { title: "t", size: 3, file: new File([], "a") },
  });

  await api.post("/uploads", {
    // @ts-expect-error a field travels as text; the coerced size takes the output, a number
    form: { title: "t", size: "big", file: new File([], "a") },
  });

  await api.post("/forms", {
    form: { a: "x", b: [1, 2], at: new Date(), file: new Blob([]) },
  });
  await api.post("/notes", { body: "text" });

  // @ts-expect-error a text route takes a string
  await api.post("/notes", { body: { text: 1 } });

  await api.put("/blobs/:id", { params: { id: 1 }, body: new Blob([]) });
  await api.patch("/raw");
  await api.patch("/raw", { body: { anything: true } });

  // @ts-expect-error a route without a body takes none
  await api.get("/health", { body: {} });
}

export async function optionsLeftOut() {
  await api.get("/health");
  await api.get("/health", { init: { signal: AbortSignal.timeout(1) } });

  // @ts-expect-error init is fetch's, without what the call sets itself
  await api.get("/health", { init: { method: "POST" } });
}

export function clientInit() {
  createClient({ init: { credentials: "include", cache: "no-store" } });
  createClient({ init: { signal: AbortSignal.timeout(1) } });

  // @ts-expect-error the client's init leaves out what a call sets itself
  createClient({ init: { method: "POST" } });

  // @ts-expect-error headers go in the client's own option
  createClient({ init: { headers: { "x-a": "1" } } });
}

export function urls() {
  const one: string = api.url("/users/:id", { params: { id: 1 } });
  const two: string = api.url("/users", { query: { page: 1 } });
  const three: string = api.url("/health");

  // @ts-expect-error the address of a path with a parameter needs it
  api.url("/users/:id");

  // @ts-expect-error the query has the schema's type, though another route at the path takes none
  api.url("/search", { query: { q: 1 } });

  // @ts-expect-error a path whose routes take no query takes none
  api.url("/health", { query: { anything: 1 } });

  // @ts-expect-error nor parameters
  api.url("/health", { params: { x: 1 } });

  void [one, two, three];
}

export async function detached() {
  const { get } = api;

  // @ts-expect-error a method taken off its client has no contract to read
  await get("/health");
}

// --- What a result says -----------------------------------------------------

export async function declared() {
  const res = await api.get("/users/:id", { params: { id: 1 } });

  if (res.ok) {
    check<Equal<typeof res.data, JsonUser>>();
    check<Equal<typeof res.status, 200>>();

    return;
  }

  if (res.status === 404) {
    check<
      Equal<
        typeof res.error,
        { status: 404; error: "USER_NOT_FOUND"; message: string }
      >
    >();

    return;
  }

  if (res.status === 422) {
    check<Equal<typeof res.error, ErrorBody>>();
    check<
      Equal<typeof res.error.issues, readonly ValidationIssue[] | undefined>
    >();

    return;
  }

  if (res.status === 502) {
    check<Equal<typeof res.error, ErrorBody | undefined>>();

    return;
  }

  // @ts-expect-error a status outside the registry does not compare
  void (res.status === 599);
}

export async function everyStatus() {
  const res = await api.post("/users", { body: { name: "n" } });

  switch (res.status) {
    case 201: {
      check<Equal<typeof res.data, JsonUser>>();
      break;
    }
    case 409: {
      check<Equal<typeof res.error.error, "NAME_TAKEN">>();
      break;
    }
    case 500: {
      check<Equal<typeof res.error, ErrorBody | undefined>>();
      break;
    }
    default: {
      check<Equal<typeof res.ok, false>>();
    }
  }
}

export async function bodiless() {
  const removed = await api.delete("/users/:id", { params: { id: 1 } });

  if (removed.ok) {
    check<Equal<typeof removed.data, undefined>>();
  }

  const exported = await api.get("/export");

  if (exported.ok) {
    check<Equal<typeof exported.data, undefined>>();
  }
}

export async function oneSchema() {
  const res = await api.get("/users");

  if (res.ok) {
    check<Equal<typeof res.data, JsonUser>>();
    check<
      Equal<
        200 extends typeof res.status
          ? 201 extends typeof res.status
            ? true
            : false
          : false,
        true
      >
    >();
  }
}

export async function undeclaredResponse() {
  const res = await api.get("/health");

  if (res.ok) {
    check<Equal<typeof res.data, unknown>>();
    check<Equal<typeof res.status, SuccessStatus>>();
  } else if (res.status === 404) {
    check<Equal<typeof res.error, ErrorBody>>();
  } else if (res.status === 503) {
    check<Equal<typeof res.error, ErrorBody | undefined>>();
  }
}

export async function plusJson() {
  const res = await api.get("/problems");

  if (res.ok) {
    check<Equal<typeof res.data, { id: number }>>();
  } else if (res.status === 404) {
    check<Equal<typeof res.error, { title: string }>>();
  }
}

export async function ranges() {
  const res = await api.get("/ranged");

  if (!res.ok && res.status === 400) {
    check<Equal<typeof res.error, { title: string }>>();
  }

  if (!res.ok && res.status === 503) {
    check<
      Equal<
        typeof res.error,
        { status: 404; error: "USER_NOT_FOUND"; message: string }
      >
    >();
  }

  const fallback = await api.get("/fallback");

  if (!fallback.ok) {
    check<Equal<typeof fallback.error, { title: string }>>();
  }
}

export async function envelope() {
  interface AppError {
    readonly code: string;
  }

  const own = createClient<typeof app, { error: AppError }>();
  const res = await own.get("/users/:id", { params: { id: 1 } });

  if (!res.ok && res.status === 500) {
    check<Equal<typeof res.error, AppError | undefined>>();
  }

  if (!res.ok && res.status === 401) {
    check<Equal<typeof res.error, AppError>>();
  }

  if (!res.ok && res.status === 404) {
    check<Equal<typeof res.error.error, "USER_NOT_FOUND">>();
  }

  // @ts-expect-error the second argument says what it tells: { error } or { headers }
  createClient<typeof app, AppError>();

  // @ts-expect-error an envelope with an error field is still not what the client is told
  createClient<typeof app, ErrorBody>();
}

export async function unwrapped() {
  const user = unwrap(await api.get("/users/:id", { params: { id: 1 } }));

  check<Equal<typeof user, JsonUser>>();

  const created = unwrap(
    await api.post("/uploads", {
      form: { title: "t", size: 1, file: new File([], "a") },
    }),
  );

  check<Equal<typeof created, undefined>>();

  const failure = {} as Failure<404, { error: "USER_NOT_FOUND" }>;
  const thrown = {} as ClientError<typeof failure>;

  check<Equal<typeof thrown.status, 404>>();
  check<Equal<typeof thrown.body, { error: "USER_NOT_FOUND" }>>();
}

// --- Where the types come from ----------------------------------------------

interface Contract {
  readonly "GET /users/:id": {
    readonly request: { readonly params: { readonly id: number } };
    readonly responses: {
      readonly 200: { readonly name: string };
      readonly 404: ErrorBody;
    };
  };
  readonly "GET /export": {
    readonly request: Record<never, never>;
    readonly responses: { readonly 200: Raw<"text/csv"> };
  };
}

export async function contract() {
  const client = createClient<Contract>();
  const res = await client.get("/users/:id", { params: { id: 1 } });

  if (res.ok) {
    check<Equal<typeof res.data, { readonly name: string }>>();
  }

  const exported = await client.get("/export");

  if (exported.ok) {
    check<Equal<typeof exported.data, undefined>>();
  }

  check<Equal<typeof client, Client<Contract, ClientTypes>>>();
}

interface Wrapped extends ContractOf<typeof app> {}

export async function wrapped() {
  const client = createClient<Wrapped>();
  const res = await client.get("/users/:id", { params: { id: 1 } });

  if (res.ok) {
    check<Equal<typeof res.data, JsonUser>>();
  }

  // @ts-expect-error the same contract, the same paths
  await client.get("/uploads");
}

export function sources() {
  check<Equal<Api["GET /users/:id"]["request"]["params"], { id: number }>>();

  // @ts-expect-error neither an application nor a contract
  createClient<{ fetch: () => void }>();

  // @ts-expect-error a key that is not a route
  createClient<{
    "GET /x": { readonly request: object; readonly responses: object };
    extra: 1;
  }>();
}

export async function untyped() {
  const loose = createClient();
  const res = await loose.post("/anything/:at", {
    params: { at: 1 },
    body: { any: true },
  });

  if (res.ok) {
    check<Equal<typeof res.data, unknown>>();
  } else {
    check<Equal<typeof res.error, unknown>>();
  }

  const thrown = unwrap(res);

  check<Equal<typeof thrown, unknown>>();
}

// --- JSON -------------------------------------------------------------------

export function json() {
  check<Equal<Jsonify<Date>, string>>();
  check<Equal<Jsonify<Map<string, number>>, Record<never, never>>>();
  check<
    Equal<
      Jsonify<{ a: string | undefined; b: number }>,
      { a?: string; b: number }
    >
  >();
  check<Equal<Jsonify<(string | undefined)[]>, (string | null)[]>>();
  check<Equal<Jsonify<readonly [Date, number]>, [string, number]>>();
  check<
    Equal<
      Jsonify<{ f: () => void; s: symbol; [key: symbol]: 1; n: number }>,
      { n: number }
    >
  >();
  check<Equal<Jsonify<unknown>, unknown>>();
  check<Equal<Jsonify<Record<string, Date>>, { [key: string]: string }>>();
  check<Equal<Jsonify<{ at: { when: Date }[] }>, { at: { when: string }[] }>>();
}

export type statusCases = [
  Expect<Equal<Extract<ServerErrorStatus, 599>, never>>,
  Expect<Equal<Success<200, 1>["ok"], true>>,
];
