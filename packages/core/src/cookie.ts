/**
 * Cookies on the way out, and the signature that makes one trustworthy.
 *
 * Reading is `materializeCookies` in `wire.ts` and validation is the
 * ordinary `cookies` slot; this module owns what the application writes
 * and, when a secret is configured, the seal on both directions.
 *
 * Internal to the core.
 *
 * @module
 */

/**
 * The attributes a cookie leaves with — Bun's own, minus the two that are
 * arguments rather than options.
 */
export type CookieAttributes = Omit<Bun.CookieInit, "name" | "value">;

/**
 * Cookies the response will carry.
 *
 * The mirror of `ctx.out.headers`, and named to match `ctx.cookies` the
 * same way `ctx.out.headers` matches `ctx.headers`: what arrived on the
 * left, what leaves on the right.
 *
 * @example
 * ```ts
 * ctx.out.cookies.set("session", token, { httpOnly: true, maxAge: 3600 });
 * ctx.out.cookies.delete("session");
 * ```
 */
export interface ResponseCookies {
  /**
   * Adds a `set-cookie` for this name.
   *
   * Signed automatically when the application configured a secret and this
   * name is covered by it, so a call site never has to remember which
   * cookies are sealed.
   */
  set(name: string, value: string, attributes?: CookieAttributes): void;

  /**
   * Expires a cookie in the client.
   *
   * `path` and `domain` have to match the ones it was set with — a browser
   * treats a different path as a different cookie, and clearing the wrong
   * one looks identical from here.
   */
  delete(
    name: string,
    attributes?: Pick<CookieAttributes, "path" | "domain">,
  ): void;
}

/** How cookies are sealed, if they are. */
export interface CookieOptions {
  /**
   * The key the signature is derived from.
   *
   * Only ever used through HMAC-SHA256; it is not an encryption key, and a
   * signed cookie's value is still readable by the client. Signing answers
   * "did this value come from us", not "can this be seen".
   */
  readonly secret: string;

  /**
   * Which cookies are signed. `true` covers every one of them.
   *
   * A list is the safer default of the two: sealing everything means a
   * cookie set by anything other than this application — an analytics
   * script, a proxy — fails verification and reads as absent, which is a
   * confusing way to discover the setting.
   */
  readonly sign?: true | string | readonly string[];
}

/** The signing policy, resolved once per application. */
export interface CookieSealer {
  /** Whether this name is covered. */
  covers(name: string): boolean;

  /** `value.signature`. */
  seal(value: string): string;

  /** The value back, or `undefined` when the seal does not hold. */
  open(sealed: string): string | undefined;
}

/**
 * Builds the sealer an application runs with, or nothing when no secret
 * was configured.
 */
export function cookieSealer(
  options: CookieOptions | undefined,
): CookieSealer | undefined {
  if (!options) {
    return undefined;
  }

  const { timingSafeEqual } =
    require("node:crypto") as typeof import("node:crypto");

  const sign = options.sign ?? true;

  const names =
    sign === true
      ? undefined
      : new Set(typeof sign === "string" ? [sign] : sign);

  const digest = (value: string): string =>
    new Bun.CryptoHasher("sha256", options.secret)
      .update(value)
      .digest("base64url");

  return {
    covers: (name) => names === undefined || names.has(name),

    seal: (value) => `${value}.${digest(value)}`,

    open: (sealed) => {
      /**
       * The last dot, not the first: a signed value may hold dots of its
       * own — a JWT is three fields separated by them — and only the
       * signature is known to be appended last. A dot at the start is an
       * empty value sealed, not a missing one.
       */
      const cut = sealed.lastIndexOf(".");

      if (cut < 0) {
        return undefined;
      }

      const value = sealed.slice(0, cut);

      return same(sealed.slice(cut + 1), digest(value), timingSafeEqual)
        ? value
        : undefined;
    },
  };
}

/**
 * Compares two signatures without leaking where they diverge.
 *
 * Lengths are checked first because `timingSafeEqual` throws on a mismatch
 * rather than returning `false`, and a signature's length is fixed by the
 * digest anyway — there is nothing in it to learn.
 *
 * `timingSafeEqual` is handed in by {@link cookieSealer}, which loads
 * `node:crypto` only when the application signs cookies: imported at the
 * top of this module, it cost every process that imports the core 4.7 MB
 * resident, signing or not (`bench/src/http.ts`, idle memory).
 *
 * No test can tell `timingSafeEqual` from `===`: both return the same
 * answer, and only the time differs. What guards it is the lint — a
 * comparison rewritten without it leaves this parameter unused, which
 * `noUnusedFunctionParameters` fails.
 */
function same(
  a: string,
  b: string,
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean,
): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The write side, over a `Headers` the caller owns.
 *
 * `set-cookie` is the one header that legitimately repeats, so cookies of
 * different names accumulate — a response may rotate a session and clear a
 * flash message at once. Two writes of the *same* name do not: the later
 * one replaces the earlier, which is what `set` has to mean to be called
 * that. Emitting both would leave the answer to the browser's
 * last-one-wins rule, and a header the server did not intend to send.
 */
export function responseCookies(
  headers: () => Headers,
  sealer: CookieSealer | undefined,
): ResponseCookies {
  const write = (name: string, cookie: Bun.Cookie): void => {
    const target = headers();

    forget(target, name);

    target.append("set-cookie", cookie.toString());
  };

  return {
    set(name, value, attributes) {
      const sealed = sealer?.covers(name) ? sealer.seal(value) : value;

      write(name, new Bun.Cookie(name, sealed, attributes));
    },

    delete(name, attributes) {
      write(name, new Bun.Cookie(name, "", { ...attributes, maxAge: 0 }));
    },
  };
}

/**
 * Drops every `set-cookie` already staged under this name.
 *
 * `Headers` has no way to remove one value of a repeated header, so the
 * list is read, filtered and written back. It runs once per cookie write
 * over a list that holds one entry per cookie, which is the size it is.
 *
 * Names are compared case-sensitively because cookie names are:
 * `Session` and `session` are two cookies, and treating them as one would
 * silently drop whichever was written first.
 */
function forget(headers: Headers, name: string): void {
  const staged = headers.getSetCookie();

  if (staged.length === 0) {
    return;
  }

  const kept = staged.filter((value) => nameOf(value) !== name);

  if (kept.length === staged.length) {
    return;
  }

  headers.delete("set-cookie");

  for (const value of kept) {
    headers.append("set-cookie", value);
  }
}

/** The name a serialized `set-cookie` carries, before the first `=`. */
function nameOf(setCookie: string): string {
  const cut = setCookie.indexOf("=");

  return cut === -1 ? setCookie : setCookie.slice(0, cut);
}
