/**
 * What hooks, and the handlers packages hand out, contribute to the
 * documentation.
 *
 * What a route is protected by, or answers with when a guard refuses, is
 * not in its config: a hook is a function in a slot, and the route that
 * mounts it says nothing about tokens or rate limits. The contribution is
 * therefore annotated onto the hook — from this package, not from
 * `hook.*` — so the core keeps knowing nothing about OpenAPI and the
 * factories stay free of documentation options. A package's handler is
 * annotated the same way, for the routes that mount it.
 *
 * A hook annotated once is documented everywhere it runs: application and
 * group chains are merged into every route's chains at startup, so a guard
 * mounted on a zone documents the zone's operations without repeating
 * itself.
 *
 * @module
 */

import type { AnyHook, AnySchema } from "@tetsujs/core";
import type { JsonSchema } from "./json-schema.ts";
import { isMediaType } from "./media.ts";

/**
 * The definition of a scheme, as OpenAPI spells it.
 *
 * Typed as loosely as the spec is wide — `http`, `apiKey`, `oauth2`,
 * `openIdConnect` and `mutualTLS` carry different fields, and narrowing
 * them here would be a second, poorer copy of the specification.
 */
export interface SecurityScheme {
  readonly type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS";
  readonly [key: string]: unknown;
}

/** What a hook demands of a request, and what it answers when refused. */
export interface SecurityRequirement {
  /** The name the scheme is registered under in `components`. */
  readonly name: string;

  /** The scheme itself, registered once per name. */
  readonly scheme: SecurityScheme;

  /** OAuth2 scopes; empty for every other type. */
  readonly scopes?: readonly string[];

  /** The status an unauthenticated request gets. Defaults to `401`. */
  readonly status?: number;

  /** How the refusal is described in the document. */
  readonly description?: string;

  /**
   * The `error` code the refusal carries, when the guard answers with the
   * framework's envelope — `"UNAUTHORIZED"`, `"SESSION_EXPIRED"`.
   *
   * Documented as a `const` for the same reason as on a
   * {@link DocumentedResponse}: only the guard knows its own code.
   */
  readonly error?: string;

  /** An example of the refusal's `message`, for the same reason. */
  readonly message?: string;
}

/**
 * One response a hook can produce, which the route's own schema knows
 * nothing about — a rate limiter's `429`, a guard's `401` — or one a
 * package's handler answers with, for the routes that mount it: a file,
 * a `304`.
 */
export interface DocumentedResponse {
  readonly status: number;
  readonly description: string;

  /**
   * The body, when it is described: JSON, or the content under
   * `contentType` when there is one.
   *
   * Without `schema` or `contentType`, an error status — `400` and above —
   * answers with the framework's envelope, which `error`, `message` and
   * `fields` describe, and any other status carries no body: a `304`, a
   * redirect.
   */
  readonly schema?: AnySchema;

  /**
   * The media type of the body when it is not JSON — `"text/html"`, or a
   * range such as `"image/*"` or the range of every type for a file whose
   * type is not known in advance. Without a `schema`, the body is
   * described by its type alone.
   *
   * Two responses of one status with different types are both in the
   * document, each under its own: the site's `404.html` next to the
   * envelope an API client gets.
   */
  readonly contentType?: string;

  /**
   * The `error` code of the failure envelope, when the hook answers with
   * the framework's shape — `"RATE_LIMITED"`, `"SESSION_EXPIRED"`.
   *
   * Documented as a `const`, so a client can discriminate on it. Only the
   * hook knows its own code; without one the document says the field is a
   * string and no more.
   */
  readonly error?: string;

  /** An example of the envelope's `message`, for the same reason. */
  readonly message?: string;

  /**
   * Fields the hook adds to the envelope, as JSON Schema by name — the
   * `retryAfter` of `{ ...errorBody(429, "RATE_LIMITED"), retryAfter }`.
   *
   * Each is documented as always present. The envelope's own `status`,
   * `message` and `error` are not redefined by a field of the same name:
   * `error` is what a client discriminates on, and it stays the code the
   * hook declared. Ignored when the response has a `schema`, which says
   * everything about the body itself.
   *
   * @example
   * ```ts
   * documented(limiter, {
   *   responses: [
   *     {
   *       status: 429,
   *       description: "Too many requests",
   *       error: "RATE_LIMITED",
   *       fields: { retryAfter: { type: "integer", minimum: 0 } },
   *     },
   *   ],
   * });
   * ```
   */
  readonly fields?: Readonly<Record<string, JsonSchema>>;

  /**
   * Headers the hook sets on this response, by name — the `retry-after`
   * of a refusal.
   *
   * Documented as possible rather than required: a status several sources
   * answer with is one response in the document, and a header one of them
   * sets is not on the others'.
   */
  readonly headers?: Readonly<Record<string, DocumentedHeader>>;
}

/** A header a hook's response carries. */
export interface DocumentedHeader {
  readonly description?: string;
  readonly schema: JsonSchema;
}

/**
 * Requirements of which a hook accepts any one: a session cookie *or* a
 * bearer token, checked by one hook.
 *
 * "Either" lives inside a hook, never between hooks — every hook of a
 * route runs, so the schemes of two hooks are both required. A hook that
 * takes either of two credentials says so here, and the document lists
 * the combinations a client may bring.
 */
export interface SecurityAlternatives {
  readonly anyOf: readonly SecurityRequirement[];
}

/** Everything a hook tells the generator about itself. */
export interface HookDocs {
  /**
   * What the hook demands of a request: one requirement, or alternatives
   * of which any one will do.
   */
  readonly security?: SecurityRequirement | SecurityAlternatives;

  /** What the hook can answer with. */
  readonly responses?: readonly DocumentedResponse[];
}

/**
 * Everything a handler tells the generator about the route it answers
 * for.
 *
 * A handler a package hands out — a directory of files, say — knows what
 * it answers with better than the route it is mounted on, whose author
 * wrote one line: annotated once, it describes every route that mounts it.
 */
export interface HandlerDocs {
  /**
   * Keeps the route out of the document unless the route says
   * `docs: { hidden: false }`.
   *
   * For a handler whose routes are rarely anyone's API — the files of a
   * site — and which a generated client could not call anyway. The route's
   * own word wins either way: `docs: { hidden: true }` hides it whatever
   * the handler says.
   */
  readonly hidden?: boolean;

  /**
   * What the handler answers with, as the route's own responses: a status
   * the route's response map declares too is described by both, and a
   * route that says nothing gets no placeholder `200` in their place.
   */
  readonly responses?: readonly DocumentedResponse[];
}

/** Any handler a route can take; the context is the route's to type. */
type AnyHandler = (ctx: never) => unknown;

const docsKey = "~tetsu/hook-docs";
const handlerDocsKey = "~tetsu/handler-docs";

/**
 * Annotates a hook, or a handler, with what it contributes to the
 * documentation.
 *
 * Returns a copy: what the caller exports is what carries the annotation,
 * and a hook or a handler used elsewhere is not changed behind its
 * author's back. A handler's copy calls the handler it was made from. The
 * type is preserved exactly, so an annotated hook goes into a stack, and an
 * annotated handler onto a route, like any other.
 *
 * Annotating a handler is for one whose type is already settled — a
 * package's, typed by its own context. An arrow written inside
 * `documented()` on a route does not get the route's context, which
 * `route()` would have given it, and does not compile; its statuses belong
 * in the route's response map.
 *
 * One signature, for a hook and a handler alike, and one shape of what is
 * said about either. An overload for each would keep `hidden` off a hook
 * and `security` off a handler in the types, but TypeScript before 7
 * reports a call no overload matches on the whole call, and a misspelled
 * keyword deep in a response would no longer be pointed at. Those two are
 * refused here instead, when `documented()` is called — as a module loads,
 * before anything is served.
 *
 * @example A hook
 * ```ts
 * export const limiter = documented(hook.beforeParse(check), {
 *   responses: [
 *     { status: 429, description: "Rate limit exceeded", schema: TooMany },
 *   ],
 * });
 * ```
 *
 * @example A package's handler, out of the document until a route asks
 * ```ts
 * return documented(serveFile, {
 *   hidden: true,
 *   responses: [
 *     { status: 200, description: "The file", contentType: "image/*" },
 *     { status: 304, description: "Not modified" },
 *   ],
 * });
 * ```
 */
export function documented<T extends AnyHook | AnyHandler>(
  target: T,
  docs: HookDocs & HandlerDocs,
): T {
  const handled = typeof target === "function";

  if (handled && docs.security !== undefined) {
    throw new Error(
      "documented() was given security for a handler — security is stated on the hook that enforces it, with secured()",
    );
  }

  if (!handled && docs.hidden !== undefined) {
    throw new Error(
      "documented() was given hidden for a hook — a route is hidden by its own docs, or by its handler's annotation, not by a hook it mounts",
    );
  }

  for (const response of docs.responses ?? []) {
    if (
      response.contentType !== undefined &&
      !isMediaType(response.contentType)
    ) {
      throw new Error(
        `The ${response.status} response given to documented() has the content type ${JSON.stringify(response.contentType)}, which is not a type such as text/html or a range such as image/* — the type alone, without parameters: the charset belongs on the response`,
      );
    }
  }

  if (handled) {
    const handler = target as AnyHandler;
    const copy: AnyHandler = (ctx) => handler(ctx);

    Object.defineProperty(copy, handlerDocsKey, {
      enumerable: false,
      value: { ...handlerDocsOf(handler), ...docs },
    });

    return copy as T;
  }

  const hook = target as AnyHook;
  const annotated = { ...hook };

  Object.defineProperty(annotated, docsKey, {
    enumerable: false,
    value: { ...docsOf(hook), ...docs },
  });

  return annotated as T;
}

/**
 * Annotates a hook with the security it enforces — {@link documented} for
 * the case that comes up most.
 *
 * One requirement, or `{ anyOf: [...] }` for a hook that accepts any one
 * of several: the schemes of different hooks are all required, the
 * alternatives of one hook are not.
 *
 * @example
 * ```ts
 * export const auth = secured(
 *   hook.beforeParse((ctx) => {
 *     const user = verify(ctx.req.headers.get("authorization"));
 *     if (!user) throw new HttpError(401);
 *     return { user };
 *   }),
 *   {
 *     name: "bearerAuth",
 *     scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
 *   },
 * );
 * ```
 *
 * @example A hook that accepts a session cookie or a bearer token
 * ```ts
 * export const caller = secured(
 *   hook.beforeParse((ctx) => {
 *     const user = sessions.fromCookie(ctx) ?? tokens.fromHeader(ctx);
 *     if (!user) throw new HttpError(401);
 *     return { user };
 *   }),
 *   { anyOf: [cookieSession, bearerToken] },
 * );
 * ```
 */
export function secured<H extends AnyHook>(
  hook: H,
  requirement: SecurityRequirement | SecurityAlternatives,
): H {
  return documented(hook, { security: requirement });
}

/** Reads everything a hook was annotated with. */
export function docsOf(hook: AnyHook): HookDocs | undefined {
  return (hook as unknown as Record<string, HookDocs | undefined>)[docsKey];
}

/** Reads everything a handler was annotated with. */
export function handlerDocsOf(handler: unknown): HandlerDocs | undefined {
  return typeof handler === "function"
    ? (handler as unknown as Record<string, HandlerDocs | undefined>)[
        handlerDocsKey
      ]
    : undefined;
}

/** Reads the security a hook was annotated with, if it was. */
export function securityOf(
  hook: AnyHook,
): SecurityRequirement | SecurityAlternatives | undefined {
  return docsOf(hook)?.security;
}

/** What the hooks of one route contribute, in execution order. */
export interface HookContributions {
  /**
   * Every scheme the hooks mention, once per name, with the scopes of all
   * of them: what the document registers, and what a refusal answers with.
   */
  readonly security: readonly SecurityRequirement[];

  /**
   * What a request must satisfy, one condition per hook: every condition
   * is required, and any one requirement of a condition satisfies it. A
   * hook with one requirement is a condition of one.
   */
  readonly conditions: readonly (readonly SecurityRequirement[])[];

  readonly responses: readonly DocumentedResponse[];
}

/**
 * Collects the contributions of a route's chains.
 *
 * A scheme is registered once per name: two hooks of one scheme asking for
 * different scopes both run, so the requirement asks for the scopes of
 * both — each once, in the order they were first asked for. Responses are
 * kept as the hooks give them. Two guards may answer one status with one
 * description and different codes, and both are what the route sends;
 * answers that say the same are folded when the document is written.
 *
 * Deduplicating by name means two hooks claiming one name with different
 * schemes lose one of them, and that is not a duplicate being collapsed —
 * it is a requirement the route really has going undescribed. Passing
 * `warn` is how the caller hears about it; the generator does.
 */
export function contributionsOf(
  chains: Record<string, readonly AnyHook[]>,
  warn?: (message: string) => void,
): HookContributions {
  const security = new Map<string, SecurityRequirement>();
  const conditions = new Map<string, readonly SecurityRequirement[]>();
  const responses: DocumentedResponse[] = [];

  for (const slot of Object.values(chains)) {
    for (const hook of slot) {
      const docs = docsOf(hook);

      if (!docs) {
        continue;
      }

      if (docs.security) {
        const alternatives = alternativesOf(docs.security);

        conditions.set(conditionKey(alternatives), alternatives);

        for (const requirement of alternatives) {
          const claimed = security.get(requirement.name);

          if (!claimed) {
            security.set(requirement.name, requirement);
          } else if (
            JSON.stringify(claimed.scheme) ===
            JSON.stringify(requirement.scheme)
          ) {
            security.set(requirement.name, {
              ...claimed,
              scopes: joinScopes(claimed.scopes, requirement.scopes),
            });
          } else {
            warn?.(
              `two hooks claim the security scheme "${requirement.name}" with different definitions; one of them is not described`,
            );
          }
        }
      }

      responses.push(...(docs.responses ?? []));
    }
  }

  return {
    security: [...security.values()],
    conditions: [...conditions.values()],
    responses,
  };
}

/** A hook's security as the alternatives it accepts; one is one. */
function alternativesOf(
  security: SecurityRequirement | SecurityAlternatives,
): readonly SecurityRequirement[] {
  return "anyOf" in security ? security.anyOf : [security];
}

/**
 * What makes two conditions the same one: the same guard mounted on the
 * application and on a group is one condition, and counting it twice would
 * multiply its alternatives with themselves.
 */
function conditionKey(alternatives: readonly SecurityRequirement[]): string {
  return JSON.stringify(
    alternatives.map((requirement) => [
      requirement.name,
      [...(requirement.scopes ?? [])].sort(),
    ]),
  );
}

/** The scopes of two requirements of one scheme, each once, in order. */
function joinScopes(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): readonly string[] {
  const joined = [...(first ?? [])];

  for (const scope of second ?? []) {
    if (!joined.includes(scope)) {
      joined.push(scope);
    }
  }

  return joined;
}
