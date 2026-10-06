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

import type {
  OutgoingSettings,
  ResponseEntry,
  ResponseMap,
  SchemaConfig,
} from "./context.ts";
import type { CookieSealer } from "./cookie.ts";
import { outgoingCookies } from "./cookie.ts";
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
 * Picks the response contract that applies to an outgoing status, as it
 * was written: a schema for the body, or an entry with the headers and
 * cookies too. Nothing is built per request — a route whose map names only
 * bodies pays for none of what an entry adds.
 *
 * A single schema applies to every status — that contract says nothing
 * about codes. A map applies the entry the status names; `null` is a
 * contract too — that the status carries no body — and not the absence of
 * one, which is `undefined`. A status the map does not name at all is a
 * contract violation,
 * refused like a body that fails its schema — the map is the list of what
 * the route answers with, and what a client generated from it will expect.
 */
export function responseContractFor(
  declared: AnySchema | ResponseMap | undefined,
  status: number,
): AnySchema | ResponseEntry | null | undefined {
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

  return map[status] as AnySchema | ResponseEntry | null;
}

/**
 * Checks a handler's result against the contract of its status: the
 * headers and cookies on `ctx.out`, then the body. The checked body is what
 * gets serialized.
 */
export function checkAnswer(
  contract: AnySchema | ResponseEntry | null,
  result: unknown,
  status: number,
  ctx: PipelineCtx,
  sealer: CookieSealer | undefined,
): unknown | PromiseLike<unknown> {
  if (contract === null) {
    return bodiless(result, status);
  }

  if ("~standard" in contract) {
    return checkResponse(contract as AnySchema, result);
  }

  const entry = contract as ResponseEntry;

  if (entry.contentType !== undefined && !isJson(entry.contentType)) {
    throw new ResponseContractError(
      `Handler returned ${result === undefined ? "nothing" : "a value"} for ${status}, which its response map declares as ${entry.contentType} — return a Response that carries it`,
    );
  }

  const body = (): unknown | PromiseLike<unknown> =>
    entry.body ? checkResponse(entry.body, result) : bodiless(result, status);

  const headers = entry.headers
    ? checkOutgoing(entry.headers, outgoingHeaders(ctx.out), "headers")
    : undefined;

  const cookies = (): void | PromiseLike<void> =>
    entry.cookies
      ? checkOutgoing(
          entry.cookies,
          outgoingCookies(
            ctx.out.createdHeaders,
            (ctx.req as Request & { readonly cookies?: Bun.CookieMap }).cookies,
            sealer,
          ),
          "cookies",
        )
      : undefined;

  if (isThenable(headers)) {
    return headers.then(cookies).then(body);
  }

  const checked = cookies();

  return isThenable(checked) ? checked.then(body) : body();
}

/**
 * Whether a status's content type is the one a returned value is sent
 * with. Media types are compared without regard to case.
 */
function isJson(contentType: string): boolean {
  return contentType.toLowerCase() === "application/json";
}

/**
 * The body of a status declared without one: nothing.
 *
 * A value returned for it is refused rather than sent. The compiler
 * catches it only where every status of the map is bodiless — the
 * handler's result is the union of all of them, not tied to the status it
 * set — and a value sent under such a status skips every schema, the
 * stripping of fields a `200` would have done included. `null` is a body:
 * the JSON `null`.
 */
function bodiless(result: unknown, status: number): undefined {
  if (result !== undefined) {
    throw new ResponseContractError(
      `Handler returned a body for ${status}, which its response map declares without one`,
    );
  }

  return undefined;
}

/**
 * The headers `ctx.out` carries, as a schema checks them: names in lower
 * case, as `Headers` gives them, and `set-cookie` left to the cookies.
 * Prototype-free, as every record of names from outside the core is.
 */
function outgoingHeaders(out: OutgoingSettings): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);

  for (const [name, value] of out.createdHeaders ?? []) {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  }

  return headers;
}

/** Checks one outgoing part; a refusal is the response's, not the client's. */
function checkOutgoing(
  schema: AnySchema,
  value: unknown,
  part: "headers" | "cookies",
): void | PromiseLike<void> {
  const outcome = schema["~standard"].validate(value);

  return isThenable(outcome)
    ? outcome.then((result) => refuseOutgoing(result, part))
    : refuseOutgoing(outcome, part);
}

function refuseOutgoing(
  result: StandardResult<unknown>,
  part: "headers" | "cookies",
): void {
  if (result.issues) {
    throw new ResponseContractError(
      `Handler's response ${part} do not match their schema`,
      result.issues,
    );
  }
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

/**
 * The validated value of a part, or the raw one with its issues recorded.
 *
 * A refusal with no issues — the specification allows an empty list — is
 * recorded as one issue on the part, so it is still a refusal: the request
 * fails on whether any were recorded.
 */
function partValue(
  result: StandardResult<unknown>,
  value: unknown,
  part: string,
  issues: ValidationIssue[],
): unknown {
  if (result.issues) {
    if (result.issues.length === 0) {
      issues.push({ message: "Invalid value", path: [part] });
    }

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
