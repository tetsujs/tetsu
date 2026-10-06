/**
 * Conditional requests: whether the copy a client holds is still the
 * file, and whether a range it asks for still belongs to it.
 *
 * Bun answers neither for a file a handler returns. It sends no `ETag` or
 * `Last-Modified`, never a `304`, and ignores `If-Range`, though it does
 * cut a `Range` out of the file itself.
 *
 * @module
 */

/**
 * A weak entity tag from the file's size and modification time, both in
 * hexadecimal: `W/"1a2b-18f3c2d4e5f"`.
 *
 * The time is in milliseconds, as Express has it. Bun's own static routes
 * use seconds, and a rebuild within the same second that keeps the size
 * would keep the tag. Weak, because nothing here reads the bytes: two
 * files with the same size and time would share it.
 */
export function entityTag(size: number, modified: number): string {
  return `W/"${size.toString(16)}-${Math.floor(modified).toString(16)}"`;
}

/**
 * Whether the client's copy is the file: `If-None-Match` names its tag, or,
 * without that header, `If-Modified-Since` is no earlier than its last
 * modification. A `304` then answers instead of the file.
 *
 * `If-None-Match` compares weakly, as a cache validation does, and `*`
 * matches any file. A date compares to the second, the precision of
 * `Last-Modified`; one that does not parse is ignored.
 */
export function isFresh(req: Request, tag: string, modified: number): boolean {
  const match = req.headers.get("if-none-match");

  if (match !== null) {
    return matchesWeakly(match, tag);
  }

  const since = req.headers.get("if-modified-since");

  if (since === null) {
    return false;
  }

  const date = Date.parse(since);

  return !Number.isNaN(date) && wholeSeconds(modified) <= date;
}

/**
 * Whether the `Range` of a request applies: it has no `If-Range`, or its
 * `If-Range` still describes the file.
 *
 * An entity tag in `If-Range` must match strongly, and the tags sent here
 * are weak, so only a date can hold: the `Last-Modified` the client was
 * given, to the second. When it does not hold, the client's partial copy
 * is of another file, and the whole one goes out.
 */
export function rangeHolds(req: Request, modified: number): boolean {
  const condition = req.headers.get("if-range")?.trim();

  if (condition === undefined) {
    return true;
  }

  if (condition.startsWith('"') || condition.startsWith("W/")) {
    return false;
  }

  return Date.parse(condition) === wholeSeconds(modified);
}

/** Whether a list of entity tags, or `*`, names `tag`, weakly compared. */
function matchesWeakly(header: string, tag: string): boolean {
  if (header.trim() === "*") {
    return true;
  }

  const opaque = withoutWeakness(tag);

  return header
    .split(",")
    .some((each) => withoutWeakness(each.trim()) === opaque);
}

/** An entity tag without its `W/`: what weak comparison compares. */
function withoutWeakness(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/** A modification time cut to the second, as an HTTP date carries it. */
function wholeSeconds(modified: number): number {
  return Math.floor(modified / 1000) * 1000;
}
