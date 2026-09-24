/**
 * Type-level tests for request context types.
 *
 * @module
 */

import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type {
  BaseCtx,
  EarlyCtx,
  Requires,
  SchemaConfig,
  ValidatedCtx,
} from "./context.ts";

const Body = mockSchema<{ qty: number }>();

const IdAsNumber = mockSchema<{ id: number }, { id: string }>();

const Query = mockSchema<{ page: number }>();

type Plain = ValidatedCtx<"/plain", SchemaConfig>;

type WithBody = ValidatedCtx<"/orders", { body: typeof Body }>;

type WithParamsSchema = ValidatedCtx<
  "/users/:id",
  { params: typeof IdAsNumber }
>;

type WithQuery = ValidatedCtx<"/search", { query: typeof Query }>;

export type cases = [
  Expect<Equal<EarlyCtx<"/users/:id">["params"], { id: string }>>,
  Expect<
    Equal<
      keyof EarlyCtx<"/health">,
      "req" | "server" | "out" | "route" | "startedAt" | "params"
    >
  >,
  Expect<
    Equal<
      keyof Plain,
      "req" | "server" | "out" | "route" | "startedAt" | "params"
    >
  >,
  Expect<Equal<keyof Plain["params"], never>>,
  Expect<Equal<WithBody["body"], { qty: number }>>,
  Expect<
    Equal<
      keyof WithBody,
      "req" | "server" | "out" | "route" | "startedAt" | "params" | "body"
    >
  >,
  Expect<Equal<WithParamsSchema["params"], { id: number }>>,
  Expect<Equal<WithQuery["query"], { page: number }>>,
  Expect<Equal<keyof Requires<{ user: string }>, keyof BaseCtx | "user">>,
  Expect<Equal<Requires<{ user: string }>["user"], string>>,
];
