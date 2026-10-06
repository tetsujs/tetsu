/**
 * What a request accepts: an HTML page, and which compressed copies.
 *
 * @module
 */

/** The encodings a compressed copy may have, by the suffix of its file. */
export const encodings = { br: ".br", gzip: ".gz" } as const;

/** An encoding a compressed copy may have. */
export type Encoding = keyof typeof encodings;

/**
 * Whether `Accept` names `text/html`: a browser's navigation does, `fetch`
 * and curl do not.
 *
 * `*` and `text/*` do not count. Every client accepts them, an API client
 * included, and a page sent to one where it expected JSON is the mistake
 * the not-found page must not make.
 */
export function acceptsHtml(req: Request): boolean {
  const header = req.headers.get("accept");

  if (header === null) {
    return false;
  }

  return header.split(",").some((part) => {
    const [type = "", ...parameters] = part.split(";");

    return (
      type.trim().toLowerCase() === "text/html" && weightOf(parameters) > 0
    );
  });
}

/**
 * The encodings of `Accept-Encoding` a compressed copy may have, most
 * wanted first: by weight, then Brotli before gzip, as it is smaller.
 *
 * An encoding with a weight of `0` is refused, and `*` stands for one the
 * header does not name.
 */
export function acceptedEncodings(req: Request): readonly Encoding[] {
  const header = req.headers.get("accept-encoding");

  if (header === null) {
    return [];
  }

  const weights = new Map<string, number>();

  for (const part of header.split(",")) {
    const [coding = "", ...parameters] = part.split(";");
    const name = coding.trim().toLowerCase();

    if (name !== "") {
      weights.set(name, weightOf(parameters));
    }
  }

  const wildcard = weights.get("*") ?? 0;

  return (Object.keys(encodings) as Encoding[])
    .map((encoding) => ({
      encoding,
      weight: weights.get(encoding) ?? wildcard,
    }))
    .filter((each) => each.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((each) => each.encoding);
}

/**
 * The `q` of a header element's parameters: `1` without one, `0` for one
 * that is not a number.
 */
function weightOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [key = "", value = ""] = parameter.split("=");

    if (key.trim().toLowerCase() === "q") {
      const weight = Number(value.trim());

      return Number.isNaN(weight) ? 0 : weight;
    }
  }

  return 1;
}
