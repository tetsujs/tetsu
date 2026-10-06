/**
 * Media types, as the document's `content` keys them.
 *
 * The core checks a route's `contentType` when the route is declared; a
 * response annotated with `documented()` reaches the document without the
 * core seeing it, so the same rule is applied here, when it is annotated.
 *
 * @module
 */

/** One part of a media type: HTTP's token characters, a range's star aside. */
const part = /^[!#$%&'+.^_`|~0-9a-z-]+$/i;

/**
 * Whether a value is a media type or a range of them, as a document's
 * `content` names it: `text/csv`, `image/*`, the range of every type — and
 * no parameters, which a key would carry into every comparison with what a
 * response says.
 */
export function isMediaType(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const [type, subtype, ...rest] = value.split("/");

  if (type === undefined || subtype === undefined || rest.length > 0) {
    return false;
  }

  if (type === "*") {
    return subtype === "*";
  }

  return part.test(type) && (subtype === "*" || part.test(subtype));
}

/**
 * Whether a media type is the one a body is described as by default, and
 * the framework sends a returned value with. Compared without regard to
 * case, as media types are.
 */
export function isJson(type: string): boolean {
  return type.toLowerCase() === "application/json";
}

/**
 * Whether a body under this key is JSON to parse: `application/json`, or
 * a type with the `+json` suffix. A range is not — its schema describes
 * the bytes of whatever type answers — and neither is `x-ndjson`, which
 * is lines of JSON, not one value.
 */
export function parsesAsJson(type: string): boolean {
  const lower = type.toLowerCase();

  return lower === "application/json" || lower.endsWith("+json");
}
