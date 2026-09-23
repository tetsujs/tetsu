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
 * Typed as loosely as the spec is wide — `http`, `apiKey`, `oauth2` and
 * `openIdConnect` carry different fields, and narrowing them here would
 * be a second, poorer copy of the specification.
 */
export interface SecurityScheme {
  readonly type: "http" | "apiKey" | "oauth2" | "openIdConnect";
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

/** Everything a hook tells the generator about itself. */
export interface HookDocs {
  /** What the hook demands of a request. */
  readonly security?: SecurityRequirement;

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
 */
export function secured<H extends AnyHook>(
  hook: H,
  requirement: SecurityRequirement,
): H {
  return documented(hook, { security: requirement });
}

/** Reads everything a hook was annotated with. */
export function docsOf(hook: AnyHook): HookDocs | undefined {
  return (hook as unknown as Record<string, HookDocs | undefined>)[docsKey];
}

/** Reads the security requirement a hook carries, if it carries one. */
export function securityOf(hook: AnyHook): SecurityRequirement | undefined {
  return docsOf(hook)?.security;
}

/** What the hooks of one route contribute, in execution order. */
export interface HookContributions {
  readonly security: readonly SecurityRequirement[];
  readonly responses: readonly DocumentedResponse[];
}

/**
 * Collects the contributions of a route's chains.
 *
 * A scheme is registered once per name and a response once per status and
 * description: the same guard on the application and on a group is one
 * requirement, not two.
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
  const responses = new Map<string, DocumentedResponse>();

  for (const slot of Object.values(chains)) {
    for (const hook of slot) {
      const docs = docsOf(hook);

      if (!docs) {
        continue;
      }

      if (docs.security) {
        const claimed = security.get(docs.security.name);

        if (!claimed) {
          security.set(docs.security.name, docs.security);
        } else if (
          JSON.stringify(claimed.scheme) !==
          JSON.stringify(docs.security.scheme)
        ) {
          warn?.(
            `two hooks claim the security scheme "${docs.security.name}" with different definitions; one of them is not described`,
          );
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
    responses: [...responses.values()],
  };
}
