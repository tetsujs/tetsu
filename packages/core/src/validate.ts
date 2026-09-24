/**
 * Schema validation — everything that talks to `~standard`.
 *
 * Validates the request parts a route's schemas declare, collecting issues
 * across parts into one `ValidationError`, and checks handler results
 * against the response schema. Standard Schema is the only interface used;
 * no validator library is imported.
 *
 * Internal to the core.
 *
 * @module
 */

import type { ResponseMap, SchemaConfig } from "./context.ts";
import type { ValidationIssue } from "./error.ts";
import { ValidationError } from "./error.ts";
import { isThenable } from "./internal.ts";
import type { Executable, PipelineCtx, PipelineOptions } from "./pipeline.ts";
import { ResponseContractError } from "./report.ts";
import type { AnySchema, StandardIssue, StandardResult } from "./schema.ts";
import {
  materializeCookies,
  materializeHeaders,
  materializeQuery,
} from "./wire.ts";

/**
 * Validates every request part the route declares a schema for.
 *
 * Parts are checked in a fixed order — `params`, `query`, `headers`,
 * `cookies`, `body` — and their issues are collected into one
 * `ValidationError`, so the client sees everything wrong with the request
 * at once. Validated values replace the raw ones in the context.
 *
 * The input of every part is the context, not the request: whatever a
 * pre-validation hook put there is what gets validated. `query`, `headers`
 * and `cookies` are materialized from the raw request only when no hook
 * produced them — a normalizing hook works the same on all five parts, and
 * materializing stays as lazy as it was.
 */
export function validate(
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
): undefined | PromiseLike<undefined> {
  const schema = entry.def.schema;

  if (!schema) {
    return undefined;
  }

  return partsFrom(0, schema, ctx, options, []);
}

/** The parts a request is validated in, in the order they are checked. */
const parts = ["params", "query", "headers", "cookies", "body"] as const;

type Part = (typeof parts)[number];

/**
 * Checks the parts from `first` on, synchronously until a validator answers
 * with a promise — the pipeline's own rule, for the same reason. The order
 * holds either way, so the issues come out in it.
 */
function partsFrom(
  first: number,
  schema: SchemaConfig,
  ctx: PipelineCtx,
  options: PipelineOptions,
  issues: ValidationIssue[],
): undefined | PromiseLike<undefined> {
  for (let index = first; index < parts.length; index += 1) {
    const part = parts[index] as Part;
    const partSchema = schema[part];

    if (!partSchema) {
      continue;
    }

    const checked = checkPart(
      partSchema,
      input(part, ctx, options),
      part,
      issues,
    );

    if (isThenable(checked)) {
      return checked.then((value) => {
        ctx[part] = value;

        return partsFrom(index + 1, schema, ctx, options, issues);
      });
    }

    ctx[part] = checked;
  }

  if (issues.length > 0) {
    throw new ValidationError(options.validationStatus, issues);
  }

  return undefined;
}

/**
 * The value a part is validated from: the context's, or — for `query`,
 * `headers` and `cookies` when no hook produced them — the request's,
 * materialized only now.
 */
function input(
  part: Part,
  ctx: PipelineCtx,
  options: PipelineOptions,
): unknown {
  switch (part) {
    case "query":
      return ctx.query ?? materializeQuery(ctx.req);
    case "headers":
      return ctx.headers ?? materializeHeaders(ctx.req);
    case "cookies":
      return ctx.cookies ?? materializeCookies(ctx.req, options.cookieSealer);
    default:
      return ctx[part];
  }
}

/**
 * Picks the response schema that applies to an outgoing status.
 *
 * A single schema applies to every status — that contract says nothing
 * about codes. A map applies the entry the status names, and nothing when
 * the entry is `null`: a status declared to carry no body has nothing to
 * check. A status the map does not name at all is a contract violation,
 * refused like a body that fails its schema — the map is the list of what
 * the route answers with, and what a client generated from it will expect.
 */
export function responseSchemaFor(
  declared: AnySchema | ResponseMap | undefined,
  status: number,
): AnySchema | undefined {
  if (declared === undefined) {
    return undefined;
  }

  if ("~standard" in declared) {
    return declared as AnySchema;
  }

  const map = declared as ResponseMap;

  if (!Object.hasOwn(map, status)) {
    const statuses = Object.keys(map).join(", ");

    throw new ResponseContractError(
      `Handler answered ${status}, which its response map does not declare (${statuses}) — set ctx.out.status to a declared one, or declare ${status}`,
    );
  }

  return map[status] ?? undefined;
}

/**
 * Validates a handler result against the route's response schema.
 *
 * A rejection is a server-side contract violation, not a client error: it
 * surfaces as a `500` with the issues reported, never leaking the offending
 * value. The validated value is what gets serialized, so a schema that
 * strips unknown keys removes them from the response.
 */
export function checkResponse(
  schema: AnySchema,
  value: unknown,
): unknown | PromiseLike<unknown> {
  const outcome = schema["~standard"].validate(value);

  return isThenable(outcome)
    ? outcome.then(responseValue)
    : responseValue(outcome);
}

function responseValue(result: StandardResult<unknown>): unknown {
  if (result.issues) {
    throw new ResponseContractError(
      "Handler result does not match its response schema",
      result.issues,
    );
  }

  return result.value;
}

function checkPart(
  schema: AnySchema,
  value: unknown,
  part: string,
  issues: ValidationIssue[],
): unknown | PromiseLike<unknown> {
  const outcome = schema["~standard"].validate(value);

  return isThenable(outcome)
    ? outcome.then((result) => partValue(result, value, part, issues))
    : partValue(outcome, value, part, issues);
}

/** The validated value of a part, or the raw one with its issues recorded. */
function partValue(
  result: StandardResult<unknown>,
  value: unknown,
  part: string,
  issues: ValidationIssue[],
): unknown {
  if (result.issues) {
    for (const issue of result.issues) {
      issues.push({
        message: issue.message,
        path: [part, ...normalizePath(issue)],
      });
    }

    return value;
  }

  return result.value;
}

/**
 * An issue's path as the keys it names.
 *
 * The specification lets a validator give each segment bare or wrapped as
 * `{ key }`, and both forms are in use; a client reading `issues` should
 * not learn which one the server's validator happened to pick. Indices
 * stay numbers, everything else becomes a string. The one reading of a
 * path in the core — HTTP validation and socket messages both go through
 * it. Internal to the core.
 */
export function normalizePath(issue: StandardIssue): (string | number)[] {
  return (issue.path ?? []).map((segment) => {
    const key =
      typeof segment === "object" && segment !== null ? segment.key : segment;

    return typeof key === "number" ? key : String(key);
  });
}
