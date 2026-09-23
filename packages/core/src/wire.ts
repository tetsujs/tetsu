/**
 * The Request/Response boundary of the pipeline: reading the body within
 * the size limit, materializing query and headers into plain objects for
 * validation, serializing handler results and applying `ctx.out.headers`
 * to outgoing responses.
 *
 * Nothing here knows about hooks or lifecycle order — that is
 * `pipeline.ts`. Internal to the core.
 *
 * @module
 */

import type {
  BodyType,
  FormBody,
  FormValue,
  Outgoing,
  OutgoingSettings,
} from "./context.ts";
import type { CookieSealer } from "./cookie.ts";
import { httpError } from "./error.ts";

/**
 * Reads and parses the request body in the shape the route declared.
 *
 * The route decides, not the `content-type` header: sniffing it would be
 * guesswork on requests that carry none — `fetch` sends no content-type
 * for a plain string body, which is how most clients post JSON. A body
 * that does not parse as the declared shape is a `400`, never a silent
 * reinterpretation.
 *
 * A stream comes back as it is, the other shapes as a promise: only they
 * have something to wait for.
 */
export function parseBody(
  req: Request,
  limit: number,
  bodyType: BodyType,
): ReadableStream<Uint8Array> | Promise<unknown> {
  if (bodyType === "stream") {
    return countedBody(req, limit);
  }

  return parseBuffered(req, limit, bodyType);
}

/**
 * The shapes that are read whole before they are parsed.
 *
 * Apart from {@link parseBody} because a stream is handed over without
 * waiting on anything, and an `async` function would turn even that into
 * a promise — and the pipeline asynchronous with it.
 */
async function parseBuffered(
  req: Request,
  limit: number,
  bodyType: Exclude<BodyType, "stream">,
): Promise<unknown> {
  if (bodyType === "form") {
    return parseForm(req, limit);
  }

  const raw = await readTextWithinLimit(req, limit);

  if (bodyType === "text") {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "MALFORMED_JSON", "Body is not valid JSON");
  }
}

/**
 * The request's own body, counted on the way past.
 *
 * Nothing is buffered: chunks reach the handler as they arrive, and the
 * only thing standing between is a counter. It is not a copy — the bytes
 * are the same bytes — so what a streaming route pays for the limit is one
 * addition per chunk.
 *
 * Crossing the limit errors the stream with the ordinary `413`, which the
 * handler's `for await` rethrows and the pipeline maps like any other
 * `HttpError`. That is later than a buffered body fails, and it has to be:
 * the handler is already running and may have already written some of the
 * upload somewhere. Undoing that is the handler's, in the `finally` it
 * would need anyway.
 *
 * An empty body is an empty stream rather than nothing, so a handler can
 * read it without asking whether there was one.
 */
function countedBody(req: Request, limit: number): ReadableStream<Uint8Array> {
  const body = req.body ?? emptyStream();

  let size = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;

        if (size > limit) {
          throw httpError(
            413,
            "BODY_TOO_LARGE",
            "Body exceeds the configured limit",
          );
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

/** A body for a request that carried none. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Parses a `multipart/form-data` or `application/x-www-form-urlencoded`
 * body into a plain object.
 *
 * The bytes are buffered first, under the same whole-body limit as every
 * other shape, and only then handed to the platform parser — the limit has
 * to be enforced while reading, and `Request.formData()` consumes the
 * stream on its own. Parsing itself stays Bun's: multipart framing is not
 * something to reimplement.
 */
async function parseForm(req: Request, limit: number): Promise<FormBody> {
  const bytes = await readBytesWithinLimit(req, limit);
  const contentType = req.headers.get("content-type") ?? "";

  const source: FormParser = new Response(bytes, {
    headers: { "content-type": contentType },
  });

  try {
    return materializeForm(await source.formData());
  } catch {
    throw httpError(400, "MALFORMED_FORM", "Body is not a valid form");
  }
}

/**
 * The form parser of the platform, declared as the contract we depend on:
 * a promise of name/value entries.
 *
 * Not called through `Response.formData()` directly because that member
 * carries a `@deprecated` tag from undici's types, and the advice behind
 * it — parse multipart with busboy instead — is Node's, not Bun's. Here
 * `formData()` is the native parser and there is nothing to replace it
 * with. Naming our own contract also spares us undici's `FormData` type,
 * whose entry values are not the global ones.
 */
interface FormParser {
  formData(): Promise<Iterable<readonly [string, FormValue]>>;
}

/**
 * Builds the form object. A repeated field becomes an array, in order of
 * appearance — the same rule as query parameters.
 *
 * Prototype-free for the same reason `materializeQuery` is: the field
 * names come from the client.
 */
function materializeForm(
  entries: Iterable<readonly [string, FormValue]>,
): FormBody {
  const body: FormBody = Object.create(null);

  for (const [name, value] of entries) {
    const existing = body[name];

    if (existing === undefined) {
      body[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      body[name] = [existing, value];
    }
  }

  return body;
}

/**
 * Reads the raw body, enforcing the configured size limit.
 *
 * A `content-length` above the limit is a `413` before a single byte is
 * read — the server enforces the declared framing, so the header can be
 * trusted when present. A chunked request declares nothing, so there the
 * limit is enforced while buffering the stream: the request is dropped at
 * the first chunk that crosses it.
 */
async function readTextWithinLimit(
  req: Request,
  limit: number,
): Promise<string> {
  if (withinDeclaredLimit(req, limit)) {
    return req.text();
  }

  if (req.body === null) {
    return "";
  }

  return Buffer.concat(await bufferWithinLimit(req.body, limit)).toString(
    "utf8",
  );
}

async function readBytesWithinLimit(
  req: Request,
  limit: number,
): Promise<Uint8Array> {
  if (withinDeclaredLimit(req, limit)) {
    return new Uint8Array(await req.arrayBuffer());
  }

  if (req.body === null) {
    return new Uint8Array(0);
  }

  return Buffer.concat(await bufferWithinLimit(req.body, limit));
}

/**
 * Checks the declared size, and reports whether the body can be read in
 * one go. A `content-length` above the limit is a `413` before a single
 * byte is read; an absent one means chunked framing, where the limit is
 * enforced while buffering instead.
 */
function withinDeclaredLimit(req: Request, limit: number): boolean {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);

  if (declared > limit) {
    throw httpError(413, "BODY_TOO_LARGE", "Body exceeds the configured limit");
  }

  return !Number.isNaN(declared);
}

async function bufferWithinLimit(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of body) {
    size += chunk.byteLength;

    if (size > limit) {
      throw httpError(
        413,
        "BODY_TOO_LARGE",
        "Body exceeds the configured limit",
      );
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Builds the query object from the request's search parameters. A repeated
 * key becomes an array, in order of appearance.
 *
 * The object is prototype-free: keys come from the attacker, and on a
 * plain `{}` a `?__proto__=` parameter would hit the `Object.prototype`
 * setter instead of creating a property — silently dropping the value and,
 * when repeated, re-pointing the object's prototype. With no prototype,
 * every key is an own data property and nothing is inherited.
 */
export function materializeQuery(
  req: Request,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = Object.create(null);

  for (const [key, value] of new URL(req.url).searchParams) {
    const existing = query[key];

    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }

  return query;
}

/**
 * Builds the cookies object a schema validates.
 *
 * Parsed from the `cookie` header rather than from `req.cookies`, which
 * Bun puts only on a request its router delivered: a handler called
 * directly in a unit test would otherwise see no cookies at all, and the
 * one place cookies are easiest to get wrong is the place that is hardest
 * to test. `Bun.CookieMap` does the parsing either way — it takes the
 * header string, so nothing is reimplemented here.
 *
 * Prototype-free for the reason `materializeQuery` is: the names come from
 * the client, and a `__proto__=` cookie must become an own property rather
 * than reach the prototype.
 */
export function materializeCookies(
  req: Request,
  sealer?: CookieSealer,
): Record<string, string> {
  const header = req.headers.get("cookie");

  const cookies: Record<string, string> = Object.create(null);

  if (!header) {
    return cookies;
  }

  for (const [name, value] of new Bun.CookieMap(header)) {
    if (!sealer?.covers(name)) {
      cookies[name] = value;

      continue;
    }

    const opened = sealer.open(value);

    /**
     * A cookie whose seal does not hold is left out rather than passed on
     * broken: the schema then reports it missing, which is what it is —
     * the application has nothing from this client under that name. Naming
     * it "invalid" instead would give a forger a way to tell a bad
     * signature from a cookie that was never sent.
     */
    if (opened !== undefined) {
      cookies[name] = opened;
    }
  }

  return cookies;
}

/**
 * Builds the headers object a schema validates.
 *
 * Names are lowercase, because that is what `Headers` guarantees and what
 * a schema therefore has to declare. Bun's `toJSON` does the whole job in
 * native code when it is there; the iterator is the fallback.
 */
export function materializeHeaders(req: Request): Record<string, string> {
  const headers = req.headers as Headers & {
    toJSON?: () => Record<string, string>;
  };

  return headers.toJSON ? headers.toJSON() : Object.fromEntries(req.headers);
}

/**
 * The status a handler's result will leave with.
 *
 * `undefined` is an answer, not an omission: a handler that returns
 * nothing has said "done, no content", which is a `204`. Everything else
 * defaults to `200`, and either yields to a status a hook or the handler
 * set.
 *
 * Exported because the status is decided once and read twice — here, and
 * where the pipeline picks the entry of `schema.response` that applies. A
 * second copy of the rule would be the familiar bug: a route declaring
 * `{ 200: Shape, 204: null }` and answering with nothing gets checked
 * against `Shape`, fails a contract it never broke, and returns `500`.
 */
export function statusFor(result: unknown, out: Outgoing): number {
  return out.status ?? (result === undefined ? 204 : 200);
}

/**
 * Turns what a handler returned into the response that leaves.
 *
 * The body follows the same split the status does: nothing for
 * `undefined`, JSON for everything else — and a stream is neither of
 * those, so it is refused here rather than serialized. See
 * {@link assertNotStreamed}.
 */
export function serialize(result: unknown, out: Outgoing): Response {
  const status = statusFor(result, out);

  if (result === undefined) {
    return new Response(null, { status });
  }

  assertNotStreamed(result);

  return Response.json(result, { status });
}

/**
 * Refuses a value that produces its content over time instead of holding
 * it.
 *
 * `JSON.stringify` sees a `ReadableStream` and a generator as objects with
 * no own enumerable properties, so both serialize to `{}`: the endpoint
 * answers `200 application/json {}`, the stream is dropped, and nothing
 * anywhere says so. It is the quietest way this framework can fail, and
 * the value most likely to be returned bare is exactly the one a streaming
 * endpoint builds.
 *
 * The door for a stream is `Response`, and it stays the only one. Wrapping
 * the value here would save a single line while guessing the thing that
 * line exists to state — the content type, which a bare stream does not
 * carry. Refusing is also the reversible half of the choice: accepting a
 * bare stream later only loosens the contract, while forbidding it later
 * would break handlers that had come to rely on it.
 *
 * Refused by class rather than by case: the platform stream, anything
 * async iterable, and a synchronous generator object. `in` walks the
 * prototype chain on purpose — a generator carries `Symbol.asyncIterator`
 * there, never as an own property — and the `Symbol.toStringTag` check is
 * what separates a generator from an array or a `Map`, which are iterable
 * and serialize perfectly well.
 *
 * The refusal is a `TypeError` rather than an `HttpError`: this is the
 * application misusing the framework, not a request being wrong, so it
 * takes the unhandled path — a logged stack for the author and a plain
 * `500` for the client, which is what every other programming error here
 * produces.
 */
function assertNotStreamed(result: unknown): void {
  if (typeof result !== "object" || result === null) {
    return;
  }

  if (result instanceof ReadableStream) {
    throw new TypeError(
      'A handler returned a ReadableStream, which JSON serializes to "{}": wrap it in the response it belongs to — `return new Response(stream, { headers: { "content-type": "text/plain" } })`',
    );
  }

  if (yieldsOverTime(result)) {
    throw new TypeError(
      'A handler returned a generator or an async iterable, which JSON serializes to "{}": collect it into a value, wrap it in a `new Response(...)`, or serve it as events with `sse()` from @tetsujs/sse',
    );
  }
}

/** Tells whether a value yields its items rather than holding them. */
function yieldsOverTime(value: object): boolean {
  if (Symbol.asyncIterator in value) {
    return true;
  }

  const tag = (value as { readonly [Symbol.toStringTag]?: unknown })[
    Symbol.toStringTag
  ];

  return tag === "Generator" || tag === "AsyncGenerator";
}

/**
 * Applies `ctx.out.headers` to the response leaving the pipeline.
 *
 * The single application point: every outcome passes through `finalize`,
 * so headers set by a hook survive error responses and short-circuits — a
 * session cookie rotation or a request id must not vanish on exactly the
 * 401 it accompanies. `out.status` is deliberately not applied here: an
 * error's status belongs to the error mapping, and a short-circuiting
 * hook states its status on the `Response` it returns.
 *
 * `set-cookie` is appended — the one header that legitimately repeats;
 * every other name overwrites. A response whose headers cannot be mutated
 * (a proxied `fetch` response has immutable headers) is copied first.
 */
export function applyOutgoingHeaders(
  res: Response,
  out: OutgoingSettings,
): Response {
  const headers = out.createdHeaders;

  if (!headers) {
    return res;
  }

  try {
    writeHeaders(res.headers, headers);

    return res;
  } catch {
    const copy = new Response(res.body, res);

    writeHeaders(copy.headers, headers);

    return copy;
  }
}

function writeHeaders(target: Headers, headers: Headers): void {
  for (const [name, value] of headers) {
    if (name === "set-cookie") {
      target.append(name, value);
    } else {
      target.set(name, value);
    }
  }
}
