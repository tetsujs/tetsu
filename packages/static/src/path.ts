/**
 * Which file a request's path names, or that it names none.
 *
 * A path is refused, never repaired: one that would have to be normalized
 * to stay inside the root is not a file of the site, and answering it
 * with the file it might have meant is how traversal gets in. Bun's own
 * static routes make the same choice.
 *
 * Bun has already done part of the work by the time a handler runs. It
 * resolves `..`, `.` and their encoded forms such as `%2e%2e` in
 * `req.url`, and turns a raw `\` into `/`. It matched the route against
 * the path as it arrived, though, so `/assets/../x` reaches the handler of
 * `/assets/*` as `/x`: a path outside the route's prefix. What is left to
 * refuse is what survives that: an encoded separator, an empty segment, a
 * NUL, a dotfile.
 *
 * @module
 */

/** A path that passed every check. */
export interface FilePath {
  /** The segments below the root, decoded; none for the root itself. */
  readonly segments: readonly string[];

  /** Whether the path ended in `/`, as the address of a directory does. */
  readonly directory: boolean;
}

/**
 * The part of `pathname` below what the route's own path matched, or
 * `undefined` for a path that must not reach the disk.
 *
 * `pattern` is the route's path: `/assets/*` leaves what follows
 * `/assets/`, and its `:params` match any one segment. A path without `*`
 * — the fallback's, or a route's such as `/robots.txt` — lies on the root
 * whole.
 *
 * Refused, each in its raw or encoded form: an empty segment (`//`), `.`
 * and `..`, a `/`, `\` or NUL inside a segment, a segment that cannot be
 * decoded, and a dotfile or dot-directory other than `.well-known`. The
 * last segment may be empty: `/docs/` is the directory `docs`.
 */
export function filePath(
  pathname: string,
  pattern: string | undefined,
): FilePath | undefined {
  const raw = pathname.split("/").slice(1);
  const fixed = prefixOf(pattern);

  for (const [position, expected] of fixed.entries()) {
    const actual = raw[position];

    if (actual === undefined || actual === "") {
      return undefined;
    }

    if (!expected.startsWith(":") && actual !== expected) {
      return undefined;
    }
  }

  const below = raw.slice(fixed.length);
  const directory = below.at(-1) === "";
  const named = directory ? below.slice(0, -1) : below;
  const segments: string[] = [];

  for (const segment of named) {
    const decoded = decodedSegment(segment);

    if (decoded === undefined) {
      return undefined;
    }

    segments.push(decoded);
  }

  return { segments, directory };
}

/**
 * The segments of a route's path before its `*`, or none for a path
 * without one.
 */
function prefixOf(pattern: string | undefined): readonly string[] {
  if (pattern === undefined || !pattern.endsWith("/*")) {
    return [];
  }

  return pattern
    .slice(1, -2)
    .split("/")
    .filter((segment) => segment !== "");
}

/**
 * One segment, decoded, or `undefined` when it must not be served.
 *
 * `.` and `..` begin with a dot, so they are refused with the dotfiles.
 */
function decodedSegment(segment: string): string | undefined {
  if (segment === "") {
    return undefined;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }

  if (/[/\\\0]/.test(decoded)) {
    return undefined;
  }

  if (decoded.startsWith(".") && decoded !== ".well-known") {
    return undefined;
  }

  return decoded;
}
