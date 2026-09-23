/**
 * Request pipeline — executes one compiled route table entry.
 *
 * Stage order is the framework's core guarantee:
 *
 * ```
 * beforeParse → parse → beforeValidation → validate → beforeHandle
 *   → handler → beforeResponse → afterResponse | onError
 * ```
 *
 * Guarantees kept here and locked by integration tests: a rejection in
 * `beforeParse` (e.g. 401) always precedes a validation failure (422); the
 * body is never read without a `body` schema; `afterResponse` runs on every
 * outcome including errors; a `Response` returned by a `before*` hook
 * short-circuits the remaining stages but still passes `beforeResponse`;
 * and `beforeResponse` sees every response, error responses included — a
 * hook decorating responses (CORS headers, a request id) must not go
 * missing on exactly the 401s and 500s where it matters most. Every
 * `beforeResponse` hook starts at most once per request: when one of them
 * throws, the mapped error response continues the chain from the next hook
 * instead of replaying it — an audit line must not be written twice. That
 * holds however deep the failure goes: a hook throwing over an already
 * failed request has its own error mapped through `onError` in turn.
 *
 * A response the pipeline builds and then does not send is released
 * rather than dropped: whatever a replaced or displaced body holds — a
 * subscription, a generator parked on an `await` — is nobody else's to
 * collect. See {@link release}.
 *
 * **Synchronous until something is not.** A request runs through the
 * stages as plain function calls, and turns asynchronous only at the first
 * stage that returns a promise — a hook that awaits, a body being read, a
 * handler that is `async` — continuing from there. An `async` function
 * costs its frame and its promise on every call even when it has nothing
 * to wait for, and those frames were most of this framework's overhead
 * over raw Bun: made synchronous, a route with two hooks costs 4% less
 * processor time a request, measured as an interleaved A/B with
 * `bench/src/http.ts`. A stage added here keeps that: it returns its
 * result, or a promise of it only when it must wait.
 * Extensions are merged into the context by mutation.
 *
 * **What this module prints, and why it prints rather than maps.**
 * `onError` turns an error into a response; `console.error` is what is left
 * when there is no response to turn it into. Five lines live here and each
 * is one of two cases: the mapping itself failed — an `onError` hook threw,
 * the error path threw again, the last-resort response could not be
 * decorated — where sending it back through `onError` is the regress that
 * just failed; or the response has already been handed over, as with an
 * `afterResponse` observer, where there is nothing left to change. The
 * sixth, `Unhandled error`, is the only one an application can silence: it
 * is printed *after* the `onError` chain declined to answer, so a hook that
 * returns a `Response` takes that line for itself.
 *
 * This module owns lifecycle order alone: schema validation lives in
 * `validate.ts`, the Request/Response boundary in `wire.ts`.
 *
 * Internal to the core.
 *
 * @module
 */

import type { Server } from "bun";
import type { BodyType, RouteInfo, SchemaConfig } from "./context.ts";
import { OutgoingSettings } from "./context.ts";
import type { CookieSealer } from "./cookie.ts";
import { errorBody, HttpError, serializedBody } from "./error.ts";
import { extendContext } from "./guard.ts";
import type { AnyHook, SlotName } from "./hook.ts";
import { isThenable } from "./internal.ts";
import { checkResponse, responseSchemaFor, validate } from "./validate.ts";
import {
  applyOutgoingHeaders,
  parseBody,
  serialize,
  statusFor,
} from "./wire.ts";

/**
 * What a handler returns when it has handed the connection over.
 *
 * A successful upgrade leaves no response to produce: the socket is the
 * answer. The pipeline stops there — `beforeResponse` and `afterResponse`
 * decorate and observe a response that in this case does not exist.
 */
export const upgraded: unique symbol = Symbol("tetsu.upgraded");

/**
 * Fully merged hook chains of one route, keyed by slot — the shape the
 * pipeline consumes. Every slot is present; an unused slot holds an empty
 * tuple. Built by the route table at startup.
 *
 * Public as the type of `RouteTableEntry.hooks`: tooling reading
 * `app.entries` needs a name for what it finds there.
 */
export type MergedHooks = { readonly [K in SlotName]: readonly AnyHook[] };

/**
 * Anything the pipeline can run: a compiled route table entry, or a
 * synthetic entry standing in for a protocol response (`404`, `405`,
 * `OPTIONS`) that carries only the application-level chains.
 */
export interface Executable {
  readonly hooks: MergedHooks;

  /**
   * What the request will see as `ctx.route`, absent on a synthetic entry
   * — nothing matched, so there is nothing to name.
   */
  readonly route?: RouteInfo | undefined;

  readonly def: {
    readonly schema?: SchemaConfig;
    readonly bodyType?: BodyType | undefined;
    readonly maxBodySize?: number;
    readonly handler: (ctx: never) => unknown;
  };
}

/**
 * Options the pipeline needs from the application config.
 */
export interface PipelineOptions {
  /** Status used when schema validation rejects the request. */
  readonly validationStatus: number;

  /**
   * Whether handler results are validated against `schema.response`.
   *
   * Structural typing only checks that the declared fields are present, so
   * a handler returning `User & { passwordHash }` compiles; this is the
   * barrier that actually keeps the extra field out of the response, by
   * using the value the validator returns (validators that strip unknown
   * keys strip them here).
   */
  readonly validateResponses: boolean;

  /**
   * Maximum request body size in bytes, enforced by `parseBody` for routes
   * that declare a `body` schema.
   */
  readonly maxBodySize: number;

  /**
   * How cookies are signed, when the application configured a secret.
   *
   * Resolved once at build time rather than per request: the policy is a
   * property of the application, and asking it per cookie is the only
   * thing a request does with it.
   */
  readonly cookieSealer?: CookieSealer | undefined;
}

/**
 * The mutable per-request state threaded through every stage. Hooks and
 * handlers receive this very object, typed through their own contracts.
 * Internal to the core: shared with `validate.ts`.
 */
export interface PipelineCtx {
  readonly req: Request;
  readonly server: Server<unknown>;
  readonly out: OutgoingSettings;
  readonly route?: RouteInfo | undefined;
  params: unknown;
  body?: unknown;
  query?: unknown;
  headers?: unknown;
  cookies?: unknown;
  res?: Response;
  error?: unknown;
}

type HookRunner = (ctx: unknown) => unknown;

/**
 * Invokes a hook against the per-request context.
 *
 * The one place phantom typing meets the runtime: a hook's `fn` was
 * checked against its own contract when the route compiled, so feeding it
 * the pipeline context is safe by construction.
 */
function call(hook: AnyHook, ctx: PipelineCtx): unknown {
  return (hook.fn as HookRunner)(ctx);
}

/**
 * Tracks how far the `beforeResponse` chain has progressed for one request.
 *
 * Shared between the success and the error path of `runPipeline`, across
 * every recovery attempt: when a `beforeResponse` hook throws, the error
 * path must not replay hooks that already ran — an audit line or a metric
 * increment would fire twice for one request. The mapped error response
 * continues the chain from the first hook that has not started yet; the
 * hook that threw is not retried. Each failed attempt therefore consumes
 * at least one hook, which is what makes recovery terminate.
 */
interface FinalizeProgress {
  ran: number;
}

/**
 * Runs one request through the full lifecycle of a route table entry.
 *
 * Returns the response itself when nothing along the way waited, and a
 * promise of it otherwise; `undefined` when the request became a
 * WebSocket.
 */
export function runPipeline(
  entry: Executable,
  req: Request,
  server: Server<unknown>,
  params: Record<string, string>,
  options: PipelineOptions,
): Response | undefined | Promise<Response | undefined> {
  const ctx: PipelineCtx = {
    req,
    server,
    out: new OutgoingSettings(options.cookieSealer),
    route: entry.route,
    params,
  };
  const progress: FinalizeProgress = { ran: 0 };

  let executed: Executed | PromiseLike<Executed>;

  try {
    executed = stagesFrom(0, entry, ctx, options);
  } catch (error) {
    return recoverThenObserve(entry, ctx, error, progress);
  }

  if (isThenable(executed)) {
    return Promise.resolve(executed).then(
      (done) => conclude(entry, ctx, done, progress),
      (error: unknown) => recoverThenObserve(entry, ctx, error, progress),
    );
  }

  return conclude(entry, ctx, executed, progress);
}

/** What the stages end with: a response, or the socket the request became. */
type Executed = Response | typeof upgraded;

/** What one stage ends with: `undefined` means go on to the next one. */
type Outcome = Executed | undefined;

/**
 * One step of the lifecycle before the response exists. A stage returns
 * `undefined` to go on, a response — its own, or a hook's short-circuit —
 * to stop, and a promise only when it has to wait.
 */
type Stage = (
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
) => Outcome | PromiseLike<Outcome>;

/** Runs a slot's hooks, when the route has any in it. */
function hooksOf(slot: "beforeParse" | "beforeValidation" | "beforeHandle") {
  return (entry: Executable, ctx: PipelineCtx) =>
    entry.hooks[slot].length > 0
      ? hooksFrom(0, entry.hooks[slot], ctx)
      : undefined;
}

/** Reads the body, when the route declares one. */
function parse(
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
): PromiseLike<undefined> | undefined {
  if (!entry.def.schema?.body && !entry.def.bodyType) {
    return undefined;
  }

  const body = parseBody(
    ctx.req,
    entry.def.maxBodySize ?? options.maxBodySize,
    entry.def.bodyType ?? "json",
  );

  if (isThenable(body)) {
    return body.then((parsed) => {
      ctx.body = parsed;

      return undefined;
    });
  }

  ctx.body = body;

  return undefined;
}

/** Validates the parts the route has schemas for. */
function check(
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
): PromiseLike<undefined> | undefined {
  if (!entry.def.schema) {
    return undefined;
  }

  const checked = validate(entry, ctx, options);

  return isThenable(checked) ? checked.then(() => undefined) : undefined;
}

/**
 * The lifecycle up to the response, in order. Read top to bottom, this is
 * the list in the module comment: `beforeParse → parse → beforeValidation
 * → validate → beforeHandle → handler`.
 */
const stages: readonly Stage[] = [
  hooksOf("beforeParse"),
  parse,
  hooksOf("beforeValidation"),
  check,
  hooksOf("beforeHandle"),
  handle,
];

/**
 * Runs the stages from `first` on, synchronously for as long as each one
 * answers synchronously. At the first promise the rest continues when it
 * settles — the same list, from the next stage.
 */
function stagesFrom(
  first: number,
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
): Executed | PromiseLike<Executed> {
  for (let index = first; index < stages.length; index += 1) {
    const stage = stages[index] as Stage;
    const outcome = stage(entry, ctx, options);

    if (isThenable(outcome)) {
      return outcome.then((settled) =>
        settled === undefined
          ? stagesFrom(index + 1, entry, ctx, options)
          : settled,
      );
    }

    if (outcome !== undefined) {
      return outcome;
    }
  }

  throw new Error("[tetsu] a route produced no response");
}

/**
 * Runs a slot's hooks from `first` on, synchronously until one returns a
 * promise. A hook's `Response` ends the slot and the stages; an object it
 * returns extends the context.
 */
function hooksFrom(
  first: number,
  hooks: readonly AnyHook[],
  ctx: PipelineCtx,
): Response | undefined | PromiseLike<Response | undefined> {
  for (let index = first; index < hooks.length; index += 1) {
    const result = call(hooks[index] as AnyHook, ctx);

    if (isThenable(result)) {
      return result.then(
        (settled) => absorb(settled, ctx) ?? hooksFrom(index + 1, hooks, ctx),
      );
    }

    const early = absorb(result, ctx);

    if (early) {
      return early;
    }
  }

  return undefined;
}

/** Takes in what a `before*` hook returned: a short-circuit, or an extension. */
function absorb(result: unknown, ctx: PipelineCtx): Response | undefined {
  if (result instanceof Response) {
    return result;
  }

  if (result !== undefined && result !== null && typeof result === "object") {
    extendContext(ctx, result);
  }

  return undefined;
}

/** Calls the handler and turns what it returned into the response. */
function handle(
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
): Executed | PromiseLike<Executed> {
  const result = (entry.def.handler as HookRunner)(ctx);

  return isThenable(result)
    ? result.then((settled) => answer(entry, ctx, options, settled))
    : answer(entry, ctx, options, result);
}

/**
 * The response for a handler's result: the result itself when it is a
 * `Response` or an upgrade, otherwise its serialization — through the
 * response schema of its status, when responses are validated.
 */
function answer(
  entry: Executable,
  ctx: PipelineCtx,
  options: PipelineOptions,
  result: unknown,
): Executed | PromiseLike<Response> {
  if (result instanceof Response || result === upgraded) {
    return result;
  }

  if (options.validateResponses) {
    const responseSchema = responseSchemaFor(
      entry.def.schema?.response,
      statusFor(result, ctx.out),
    );

    if (responseSchema) {
      const checked = checkResponse(responseSchema, result);

      return isThenable(checked)
        ? checked.then((value) => serialize(value, ctx.out))
        : serialize(checked, ctx.out);
    }
  }

  return serialize(result, ctx.out);
}

/**
 * Takes the stages' result the rest of the way: `beforeResponse`, the
 * outgoing headers, the observers. An upgraded socket ends here with no
 * response at all.
 */
function conclude(
  entry: Executable,
  ctx: PipelineCtx,
  executed: Executed,
  progress: FinalizeProgress,
): Response | undefined | Promise<Response | undefined> {
  if (executed === upgraded) {
    return undefined;
  }

  if (entry.hooks.beforeResponse.length > 0) {
    return finalize(entry, ctx, executed, progress).then(
      (res) => observe(entry, ctx, res),
      (error: unknown) => recoverThenObserve(entry, ctx, error, progress),
    );
  }

  let res: Response;

  try {
    res = settle(ctx, executed);
  } catch (error) {
    return recoverThenObserve(entry, ctx, error, progress);
  }

  return observe(entry, ctx, res);
}

/** The error path, then the observers, which see every outcome. */
async function recoverThenObserve(
  entry: Executable,
  ctx: PipelineCtx,
  error: unknown,
  progress: FinalizeProgress,
): Promise<Response> {
  return observe(entry, ctx, await recover(entry, ctx, error, progress));
}

/** Starts the `afterResponse` observers over the response that leaves. */
function observe(entry: Executable, ctx: PipelineCtx, res: Response): Response {
  if (entry.hooks.afterResponse.length > 0) {
    ctx.res = res;
    observersFrom(0, entry.hooks.afterResponse, ctx);
  }

  return res;
}

/**
 * Releases the response a replacement displaces.
 *
 * Exported for the one discard that happens outside this module: a `HEAD`
 * request answers by rebuilding the `GET` response without its body, which
 * is this same operation and leaks the same way.
 *
 * A response the pipeline built and then decided not to send belongs to
 * nobody else: the handler has returned, a hook chose to drop it, and the
 * runtime never sees it. Whatever its body holds — a subscription, a file
 * handle, a generator parked on an `await` — is released here or not at
 * all. Cancelling is what the platform offers a consumer that abandons a
 * body, and it is observable on purpose: telling a source that its stream
 * is over is exactly what runs the `finally` where a subscription gets
 * closed.
 *
 * The body is spared when it is the body of the replacement. Decorating a
 * response by rebuilding it — `new Response(ctx.res.body, ctx.res)` —
 * carries the very same stream object, so cancelling there would kill the
 * stream that is about to go out. A body reintroduced later, after the
 * response carrying it was already dropped, is not covered: at the moment
 * it is dropped, nothing tells it apart from a leak.
 *
 * The cancellation is not awaited. It runs the source's own `cancel()`,
 * which is application code, and a client must not wait for the cleanup of
 * a body it will never read — the reason `afterResponse` observers are not
 * awaited either. A rejection means the body is already someone else's — a
 * hook read it, or holds a reader on it — which is precisely the case
 * where there is nothing here to release.
 */
export function release(discarded: Response | undefined, next: Response): void {
  if (discarded === undefined || discarded === next) {
    return;
  }

  const body = discarded.body;

  if (body === null || body === next.body) {
    return;
  }

  void body.cancel().catch(() => {});
}

/**
 * Runs the `beforeResponse` chain over a response, resuming from the first
 * hook that has not run yet.
 *
 * Called once per request on the success path, and once per recovery
 * attempt on the error path, when a stage — possibly a `beforeResponse`
 * hook itself — threw. The shared progress cursor guarantees every hook
 * starts at most once per request; a hook is marked as started before it
 * is invoked, so the hook that threw is not retried with the mapped error
 * response.
 *
 * Both ways in go through {@link release}: on a recovery attempt the
 * mapped error response displaces the one the request had built by then,
 * which is the same discard a replacing hook makes and leaks the same way.
 */
async function finalize(
  entry: Executable,
  ctx: PipelineCtx,
  res: Response,
  progress: FinalizeProgress,
): Promise<Response> {
  release(ctx.res, res);

  ctx.res = res;

  const hooks = entry.hooks.beforeResponse;

  for (let index = progress.ran; index < hooks.length; index += 1) {
    const hook = hooks[index];

    if (hook === undefined) {
      break;
    }

    progress.ran = index + 1;

    let replaced = call(hook, ctx);

    if (isThenable(replaced)) {
      replaced = await replaced;
    }

    if (replaced instanceof Response) {
      release(ctx.res, replaced);

      ctx.res = replaced;
    }
  }

  return settle(ctx, ctx.res);
}

/**
 * Lays `ctx.out.headers` over the response that leaves, and records it.
 *
 * The last step of {@link finalize}, and all of it for a route without
 * `beforeResponse` hooks — which then skips `finalize` altogether: an
 * `async` function that has nothing to wait for still costs its frame on
 * every request, and those frames were most of this framework's overhead
 * over raw Bun (`bench/src/http.ts`).
 */
function settle(ctx: PipelineCtx, res: Response): Response {
  ctx.res = applyOutgoingHeaders(res, ctx.out);

  return ctx.res;
}

/**
 * Produces the response for a request that threw, and keeps producing one
 * when the error path throws in turn.
 *
 * Every attempt maps the current error through `onError` and runs the rest
 * of the `beforeResponse` chain over the result. A hook that throws while
 * the response is already an error response is therefore not the end of the
 * request: its own error reaches `onError`, the hooks after it still run,
 * and `ctx.out` still lands on whatever goes out — the same promises the
 * success path makes.
 *
 * The loop terminates on its own: a failing `finalize` has consumed at
 * least one hook, and a failing `mapError` leaves a plain error, which its
 * last branch always maps. The bound is a backstop, not the mechanism.
 */
async function recover(
  entry: Executable,
  ctx: PipelineCtx,
  error: unknown,
  progress: FinalizeProgress,
): Promise<Response> {
  const attempts = entry.hooks.beforeResponse.length + 2;

  let pending = error;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const mapped = await mapError(entry, ctx, pending);

      return await finalize(entry, ctx, mapped, progress);
    } catch (failure) {
      console.error("[tetsu] Error response failed:", failure);

      pending = failure;
    }
  }

  return hardFailure(ctx);
}

/**
 * The last response the pipeline can produce: a bare 500 for a request
 * whose error path kept failing. It still carries `ctx.out` headers — a
 * response decorated by nothing else is exactly where a CORS header
 * decides whether the client sees the status at all.
 *
 * No request is known to reach it, and that is the intended state rather
 * than an untested gap: `recover` bounds itself above what its own
 * reasoning says it needs, and every way of failing that has been tried —
 * a mapper on a circular body, an `onError` hook that throws, one that
 * returns a value instead of a response, a `beforeResponse` hook throwing
 * on the error path — is answered a step earlier. It is kept because the
 * alternative to a backstop that never fires is a loop that can end with
 * nothing to return, and because the reasoning it stands on is about code
 * that will keep changing.
 */
function hardFailure(ctx: PipelineCtx): Response {
  const res = Response.json(errorBody(500), { status: 500 });

  try {
    return applyOutgoingHeaders(res, ctx.out);
  } catch (failure) {
    console.error("[tetsu] Failed to apply response headers:", failure);

    return res;
  }
}

/**
 * Runs the `afterResponse` observers from `first` on, in order.
 *
 * Not awaited by the pipeline: an async observer — shipping an access log,
 * flushing a metric — must not become part of the client's latency, so the
 * observers after it run when it settles, and the response has already
 * gone. Synchronous observers complete before the response is returned. A
 * failing observer is printed and the next one runs: there is no response
 * left to change.
 */
function observersFrom(
  first: number,
  observers: readonly AnyHook[],
  ctx: PipelineCtx,
): void {
  for (let index = first; index < observers.length; index += 1) {
    let result: unknown;

    try {
      result = call(observers[index] as AnyHook, ctx);
    } catch (error) {
      console.error("[tetsu] afterResponse hook failed:", error);

      continue;
    }

    if (isThenable(result)) {
      void result.then(
        () => observersFrom(index + 1, observers, ctx),
        (error: unknown) => {
          console.error("[tetsu] afterResponse hook failed:", error);
          observersFrom(index + 1, observers, ctx);
        },
      );

      return;
    }
  }
}

async function mapError(
  entry: Executable,
  ctx: PipelineCtx,
  error: unknown,
): Promise<Response> {
  ctx.error = error;

  for (const hook of entry.hooks.onError) {
    try {
      let mapped = call(hook, ctx);

      if (isThenable(mapped)) {
        mapped = await mapped;
      }

      if (mapped instanceof Response) {
        return mapped;
      }
    } catch (hookError) {
      console.error("[tetsu] onError hook failed:", hookError);
    }
  }

  if (error instanceof HttpError) {
    return Response.json(serializedBody(error), { status: error.status });
  }

  console.error("[tetsu] Unhandled error:", error);

  return Response.json(errorBody(500), { status: 500 });
}
