/**
 * Type-level tests for the TypeBox adapter.
 *
 * @module
 */

import type { InferOutput } from "@tetsujs/core";
import { route } from "@tetsujs/core";
import { Type } from "typebox";
import { tb } from "./index.ts";

declare function expectType<T>(value: T): void;

const CreateUser = tb(
  Type.Object({
    name: Type.String(),
    email: Type.String(),
    age: Type.Optional(Type.Number()),
  }),
);

const UserParams = tb(Type.Object({ id: Type.Integer() }), { convert: true });

const User = tb(Type.Object({ id: Type.Integer(), name: Type.String() }));

const Stored = tb(
  Type.Object({
    at: Type.Codec(Type.String({ format: "date-time" }))
      .Decode((value) => new Date(value))
      .Encode((value: Date) => value.toISOString()),
    count: Type.Codec(Type.String()).Decode(Number).Encode(String),
  }),
);

export type inferenceCases = [
  // A codec is validated into what it decodes to, not what it reads.
  InferOutput<typeof Stored> extends { at: Date; count: number } ? true : false,
  InferOutput<typeof CreateUser> extends {
    name: string;
    email: string;
    age?: number;
  }
    ? true
    : false,
  InferOutput<typeof UserParams> extends { id: number } ? true : false,
];

route({
  method: "POST",
  path: "/users/:id",
  schema: { params: UserParams, body: CreateUser, response: User },
  handler: (ctx) => {
    expectType<number>(ctx.params.id);
    expectType<string>(ctx.body.name);
    expectType<number | undefined>(ctx.body.age);

    return { id: ctx.params.id, name: ctx.body.name };
  },
});

route({
  method: "GET",
  path: "/users/:id",
  schema: { params: UserParams, response: User },
  // @ts-expect-error the response DTO declares id as a number
  handler: (ctx) => ({ id: String(ctx.params.id), name: "x" }),
});
