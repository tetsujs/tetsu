/**
 * The response headers a browser reads as instructions.
 *
 * ```ts
 * const secure = secureHeaders();
 *
 * createApp({ hooks: { beforeResponse: [secure] }, routes });
 * ```
 *
 * Four of them are on without being asked for, because none of the four
 * can break a JSON API and every one of them closes something: content
 * sniffing, a referrer leaking a path to a third party, the endpoint being
 * framed, and the connection being downgraded to plain HTTP.
 *
 * A Content-Security-Policy is not among them, and that is the one
 * deliberate omission — see {@link SecureHeadersOptions.contentSecurityPolicy}.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { hook } from "@tetsujs/core";

/** How long a browser remembers to use HTTPS, and for what. */
export interface HstsOptions {
  /**
   * Lifetime in seconds. 180 days by default.
   *
   * Long enough to matter and short enough to be wrong about: the browser
   * refuses plain HTTP to this host until it expires, and there is no way
   * to reach the browsers that already heard it.
   */
  readonly maxAge?: number;

  /**
   * Whether every subdomain is covered too. Off by default.
   *
   * A subdomain served over HTTP — a legacy box, a status page, a
   * certificate-less internal tool — stops being reachable the moment one
   * request to the parent carries this, for as long as `maxAge` says. It
   * is the right setting for most deployments and the wrong default for
   * any of them.
   */
  readonly includeSubDomains?: boolean;

  /**
   * Whether the domain asks to be built into browsers. Off by default.
   *
   * Getting out of the preload list takes months and a new browser
   * release, so this one is not a setting that can be rolled back the way
   * a deploy can.
   */
  readonly preload?: boolean;
}

/** Which headers go out, and what they say. */
export interface SecureHeadersOptions {
  /**
   * `strict-transport-security`, or `false` to leave it off.
   *
   * Sent on every response, including those that arrived over plain HTTP,
   * where the browser is required to ignore it — so this needs to know
   * nothing about proxies or protocols to be correct.
   */
  readonly hsts?: HstsOptions | false;

  /** `x-frame-options`. `"DENY"` by default, `false` to leave it off. */
  readonly frameOptions?: "DENY" | "SAMEORIGIN" | false;

  /** `referrer-policy`. `"no-referrer"` by default, `false` to leave it off. */
  readonly referrerPolicy?: string | false;

  /** `x-content-type-options: nosniff`. On unless set to `false`. */
  readonly noSniff?: boolean;

  /**
   * `content-security-policy`. **Off by default**, and alone in that.
   *
   * A policy is a statement about a document, and this framework answers
   * with documents only where an application chose to. A default strict
   * enough to be worth having would break the first page anyone serves,
   * including this repository's own documentation page — `docsPage()`
   * loads its renderer from a CDN and carries an inline script, so
   * `default-src 'none'` would blank it. A default loose enough not to
   * break it would protect nothing.
   *
   * What breaks is also the wrong kind of breakage to inflict silently: a
   * policy is enforced in the browser, so the failure is a blank page and
   * a console message on someone else's machine, not an error on the
   * server.
   *
   * An API that answers only JSON should still have one, and {@link
   * apiPolicy} is it.
   */
  readonly contentSecurityPolicy?: string | false;
}

/**
 * A policy for an endpoint that only ever answers JSON: it may load
 * nothing, be framed by nobody, and have no base or form target.
 *
 * Every directive is a denial, which is what makes it safe to hand out —
 * there is nothing in it to tune for a particular application, and an
 * endpoint it breaks was serving a document rather than an API.
 *
 * @example
 * ```ts
 * const secure = secureHeaders({ contentSecurityPolicy: apiPolicy });
 * ```
 */
export const apiPolicy =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The hook of this package.
 *
 * Read off `secureHeaders()` rather than written by hand: an annotation of
 * `AnyHook` would erase which slot the hook belongs to, and the stack
 * validation would then reject the hook it was handed.
 */
export type SecureHeadersHook = ReturnType<typeof secureHeaders>;

const defaultMaxAge = 15_552_000;

const preloadMinimumMaxAge = 31_536_000;

/**
 * Builds the hook that writes them.
 *
 * One hook, in `beforeResponse`, writing to `ctx.out.headers`: that slot
 * sees every outgoing response — errors, a `404`, a refusal short-circuited
 * out of `beforeParse` — and those headers are applied to all of them. A
 * `401` is exactly the response an attacker is iterating over, and the
 * least useful one to leave undecorated.
 *
 * The header values do not depend on the request, so they are assembled
 * once here and only written per response.
 *
 * @example
 * ```ts
 * const secure = secureHeaders({
 *   hsts: { maxAge: 63_072_000, includeSubDomains: true },
 *   contentSecurityPolicy: apiPolicy,
 * });
 * ```
 */
export function secureHeaders(options: SecureHeadersOptions = {}) {
  const headers = assemble(options);

  const decorate = hook.beforeResponse((ctx: BaseCtx) => {
    for (const [name, value] of headers) {
      ctx.out.headers.set(name, value);
    }

    return undefined;
  });

  return decorate;
}

/** Turns the options into the pairs every response will carry. */
function assemble(options: SecureHeadersOptions): readonly [string, string][] {
  const headers: [string, string][] = [];

  if (options.noSniff !== false) {
    headers.push(["x-content-type-options", "nosniff"]);
  }

  if (options.frameOptions !== false) {
    headers.push(["x-frame-options", options.frameOptions ?? "DENY"]);
  }

  if (options.referrerPolicy !== false) {
    headers.push(["referrer-policy", options.referrerPolicy ?? "no-referrer"]);
  }

  if (options.hsts !== false) {
    headers.push(["strict-transport-security", hstsValue(options.hsts ?? {})]);
  }

  if (options.contentSecurityPolicy) {
    headers.push(["content-security-policy", options.contentSecurityPolicy]);
  }

  return headers;
}

/**
 * Formats the HSTS value, refusing a combination the preload list would
 * silently drop.
 *
 * `preload` without `includeSubDomains`, or with a lifetime under a year,
 * is not a weaker request — it is no request at all: the list rejects the
 * submission and the header keeps claiming otherwise. Refusing here is the
 * same trade `cors()` makes for `"*"` with credentials, and for the same
 * reason: a mistake that fails at the browser is one nobody sees.
 */
function hstsValue(hsts: HstsOptions): string {
  const maxAge = hsts.maxAge ?? defaultMaxAge;

  if (
    hsts.preload &&
    (!hsts.includeSubDomains || maxAge < preloadMinimumMaxAge)
  ) {
    throw new Error(
      `secureHeaders: hsts.preload needs includeSubDomains and a maxAge of at least ${preloadMinimumMaxAge} seconds (one year), got ${maxAge} — the preload list refuses anything else, so the header would promise a submission that never succeeds`,
    );
  }

  const value = [`max-age=${maxAge}`];

  if (hsts.includeSubDomains) {
    value.push("includeSubDomains");
  }

  if (hsts.preload) {
    value.push("preload");
  }

  return value.join("; ");
}
