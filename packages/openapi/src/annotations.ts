/**
 * What hooks contribute to the documentation.
 *
 * What a route is protected by, or answers with when a guard refuses, is
 * not in its config: a hook is a function in a slot, and the route that
 * mounts it says nothing about tokens or rate limits. The contribution is
 * therefore annotated onto the hook — from this package, not from
 * `hook.*` — so the core keeps knowing nothing about OpenAPI and the
 * factories stay free of documentation options.
 *
 * A hook annotated once is documented everywhere it runs: application and
 * group chains are merged into every route's chains at startup, so a guard
 * mounted on a zone documents the zone's operations without repeating
 * itself.
 *
 * @module
 */

import type { AnyHook, AnySchema } from "@tetsujs/core";

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
 * nothing about — a rate limiter's `429`, a guard's `401`.
 */
export interface DocumentedResponse {
  readonly status: number;
  readonly description: string;

  /** The body, when the hook answers with one. */
  readonly schema?: AnySchema;

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

const docsKey = "~tetsu/hook-docs";

/**
 * Annotates a hook with what it contributes to the documentation.
 *
 * Returns a copy: what the caller exports is what carries the annotation,
 * and a hook used elsewhere is not changed behind its author's back. The
 * type is preserved exactly, so an annotated hook goes into a stack like
 * any other.
 *
 * @example
 * ```ts
 * export const limiter = documented(hook.beforeParse(check), {
 *   responses: [
 *     { status: 429, description: "Rate limit exceeded", schema: TooMany },
 *   ],
 * });
 * ```
 */
export function documented<H extends AnyHook>(hook: H, docs: HookDocs): H {
  const annotated = { ...hook };

  Object.defineProperty(annotated, docsKey, {
    enumerable: false,
    value: { ...docsOf(hook), ...docs },
  });

  return annotated as H;
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
 * A scheme is registered once per name and a response once per status and
 * description: the same guard on the application and on a group is one
 * requirement, not two. Two hooks of one scheme asking for different
 * scopes both run, so the requirement asks for the scopes of both — each
 * once, in the order they were first asked for.
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
  const responses = new Map<string, DocumentedResponse>();

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

      for (const response of docs.responses ?? []) {
        const key = `${response.status} ${response.description}`;

        if (!responses.has(key)) {
          responses.set(key, response);
        }
      }
    }
  }

  return {
    security: [...security.values()],
    conditions: [...conditions.values()],
    responses: [...responses.values()],
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
