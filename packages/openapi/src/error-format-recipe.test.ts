/**
 * The README's recipe for an error format of one's own, as it is written:
 * the `onError` hook, the `errors` it is described with, and the test that
 * holds them together.
 *
 * The recipe is what people copy, so it is checked as a whole: every
 * failure answers in the format the document describes — the unexpected
 * `500` included — and a failure the hook answered itself still reaches
 * the application's receiver.
 *
 * @module
 */

import { expect, test } from "bun:test";
import type { ErrorBody, FailureReport } from "@tetsujs/core";
import {
  createApp,
  HttpError,
  hook,
  reportFailure,
  route,
} from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { ErrorFormat } from "./index.ts";
import { openapi } from "./index.ts";
import { assertDescribed } from "./testing.ts";

const inOurFormat = hook.onError((ctx) => {
  const { error } = ctx;

  if (error instanceof HttpError) {
    const { status, error: code, ...rest } = error.body as ErrorBody;

    return Response.json({ code, ...rest }, { status });
  }

  reportFailure(ctx, "unhandled", error);

  return Response.json(
    { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" },
    { status: 500 },
  );
});

const errors: ErrorFormat = {
  schema: ({ error, message, fields }) => ({
    type: "object",
    required: ["code", "message", ...Object.keys(fields)],
    properties: {
      code: error ? { type: "string", const: error } : { type: "string" },
      message: { type: "string", ...(message ? { examples: [message] } : {}) },
      ...fields,
    },
  }),
  discriminator: "code",
};

const Item = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) =>
      typeof (value as { name?: unknown }).name === "string"
        ? { value: value as { name: string } }
        : { issues: [{ message: "name is required", path: ["name"] }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }),
      output: () => ({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }),
    },
  },
} as const;

const reports: FailureReport<object>[] = [];

const app = createApp({
  hooks: { onError: [inOurFormat] },
  reportError: (report) => reports.push(report),
  routes: {
    create: route({
      method: "POST",
      path: "/items",
      schema: { body: Item },
      handler: () => undefined,
    }),
    boom: route({
      method: "GET",
      path: "/boom",
      handler: () => {
        throw new Error("the database went away");
      },
    }),
  },
});

const request = serve(app);
const { document } = openapi(app, {
  info: { title: "Ours", version: "1" },
  errors,
});

test("a validation failure is what the document says", async () => {
  await assertDescribed(
    document,
    "POST /items",
    await request("/items", { method: "POST", body: "{}" }),
  );
});

test("an unexpected failure is too, and it is still reported", async () => {
  reports.length = 0;

  await assertDescribed(document, "GET /boom", await request("/boom"));

  expect(reports.map((report) => report.source)).toEqual(["unhandled"]);
});
