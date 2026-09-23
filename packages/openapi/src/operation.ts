/**
 * One route table entry, described as an OpenAPI operation.
 *
 * Bodies and responses live here; parameters are in `parameters.ts`. The
 * error responses a route can produce without the author writing anything
 * — a rejected schema, an unparsable body, a body over the limit — are
 * derived from what the route declares and from the options the
 * application actually runs with.
 *
 * @module
 */

import type {
  AnySchema,
  AppOptions,
  BodyType,
  RouteTableEntry,
} from "@tetsujs/core";
import type { HookContributions } from "./annotations.ts";
import { contributionsOf } from "./annotations.ts";
import type { SchemaComponents } from "./components.ts";
import { failureName } from "./components.ts";
import type {
  ContentMap,
  OperationObject,
  ResponseObject,
} from "./document.ts";
import type { JsonSchemaObject } from "./emit.ts";
import { emitted } from "./emit.ts";
import { partParameters, pathParameters } from "./parameters.ts";

/** Describes one route. */
export function operationOf(
  entry: RouteTableEntry,
  options: AppOptions,
  components: SchemaComponents,
  ids: OperationIds,
  warn: (message: string) => void,
): OperationObject {
  const schema = entry.def.schema;

  const parameters = [
    ...pathParameters(entry.path, schema?.params, warn),
    ...partParameters(schema?.query, "query", warn),
    ...partParameters(schema?.headers, "header", warn),
    ...partParameters(schema?.cookies, "cookie", warn),
  ];

  const body = requestBody(entry, warn);
  const contributed = contributionsOf(entry.hooks, warn);

  return {
    operationId: ids.take(entry),
    ...(entry.def.docs?.summary === undefined
      ? {}
      : { summary: entry.def.docs.summary }),
    ...(entry.def.docs?.description === undefined
      ? {}
      : { description: entry.def.docs.description }),
    ...(entry.def.docs?.tags === undefined
      ? {}
      : { tags: entry.def.docs.tags }),
    ...(entry.def.docs?.deprecated === undefined
      ? {}
      : { deprecated: entry.def.docs.deprecated }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    ...(contributed.security.length > 0
      ? {
          security: contributed.security.map((requirement) => ({
            [requirement.name]: requirement.scopes ?? [],
          })),
        }
      : {}),
    responses: responses(entry, options, contributed, components, warn),
  };
}

/**
 * Hands out the `operationId` of every route in one document.
 *
 * Uniqueness is a requirement of the specification and cannot be decided
 * one route at a time: the pair a name is built from — the controller and
 * the field — is not unique on its own. One instance mounted under two
 * prefixes is a documented pattern (`/v1` and `/v2` from the same
 * controller), and two controller classes in different modules may simply
 * share a class name. Either way the pair repeats while the routes differ.
 *
 * A repeat falls back to what the route is named by when it has no field
 * at all — its method and path — because that is derived from the route
 * rather than from the order routes were visited in. A numbered name is
 * the last resort only, since it would move between documents as routes
 * are added, and an `operationId` is what a generated client calls its
 * method.
 */
export interface OperationIds {
  /** The id for this route, unique within the document being built. */
  take(entry: RouteTableEntry): string;
}

export function operationIds(): OperationIds {
  const taken = new Set<string>();

  return {
    take(entry: RouteTableEntry): string {
      const preferred = declaredId(entry) ?? derivedId(entry);

      if (!taken.has(preferred)) {
        taken.add(preferred);

        return preferred;
      }

      const derived = derivedId(entry);

      if (!taken.has(derived)) {
        taken.add(derived);

        return derived;
      }

      let name = derived;

      for (let attempt = 2; taken.has(name); attempt += 1) {
        name = `${derived}${attempt}`;
      }

      taken.add(name);

      return name;
    },
  };
}

/**
 * The name the controller gave it: the field, qualified by the controller
 * — `usersSetAvatar` for `setAvatar` on `UsersController`.
 */
function declaredId(entry: RouteTableEntry): string | undefined {
  if (entry.name === undefined) {
    return undefined;
  }

  const controller = entry.controller.replace(/Controller$/, "");

  return `${lowerFirst(controller)}${capitalize(entry.name)}`;
}

/**
 * What identifies a route when its field does not: its method and path.
 *
 * Also the name of a route mounted standalone, which has no field to be
 * called after.
 */
function derivedId(entry: RouteTableEntry): string {
  return `${entry.method.toLowerCase()}${entry.path
    .split(/[/:*]/)
    .filter(Boolean)
    .map(capitalize)
    .join("")}`;
}

/**
 * Describes the request body, when the route reads one.
 *
 * The media type follows the declaration, not a guess: `"form"` accepts
 * both multipart and urlencoded at runtime, so both are listed — unless
 * the schema declares a binary field, which only multipart can carry.
 */
function requestBody(
  entry: RouteTableEntry,
  warn: (message: string) => void,
): { required: boolean; content: ContentMap } | undefined {
  const declared = entry.def.schema?.body;
  const bodyType = entry.def.bodyType ?? (declared ? "json" : undefined);

  if (!bodyType) {
    return undefined;
  }

  const described = declared
    ? emitted(declared, "the body", warn, "input")
    : undefined;

  const schema = described ? { schema: described } : {};

  // Whether a body must be sent is a question about the wire, not about
  // the schema: `json` and `form` parse it before anything is validated,
  // and an empty one fails that parse with a `400` — so the client has to
  // send something whether or not a shape was declared. `text` has no such
  // step, because an absent body reads as `""` just like an empty one; if
  // that string is unacceptable, the schema is where it says so. Neither
  // has `stream`: an absent body is handed over as an empty stream.
  const required = bodyType !== "text" && bodyType !== "stream";

  if (bodyType === "stream") {
    /**
     * Bytes with no shape to describe: the route takes the body unread, so
     * the document says what it is rather than what is in it. A `stream`
     * route cannot carry a body schema at all — the compiler refuses the
     * pair — so there is never a `schema` to attach here.
     */
    return { required, content: { "application/octet-stream": {} } };
  }

  if (bodyType === "text") {
    return { required, content: { "text/plain": schema } };
  }

  if (bodyType === "json") {
    return { required, content: { "application/json": schema } };
  }

  const content: ContentMap = { "multipart/form-data": schema };

  if (!described || !carriesBinary(described)) {
    content["application/x-www-form-urlencoded"] = schema;
  }

  return { required, content };
}

/**
 * Whether any part of an emitted schema describes binary content.
 *
 * Walked with a stack rather than by recursion, and remembering what it has
 * already seen: the shape comes from an adapter, so its depth is the
 * author's to choose and nothing says it is a tree. Recursion would answer
 * a deep one by overflowing the stack, and a self-referential one by never
 * returning — both while `createApp` is still assembling the application.
 */
function carriesBinary(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const node = pending.pop();

    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }

    seen.add(node);

    if ((node as { contentEncoding?: unknown }).contentEncoding === "binary") {
      return true;
    }

    for (const value of Object.values(node)) {
      pending.push(value);
    }
  }

  return false;
}

/**
 * Describes what the route answers with.
 *
 * The declared responses come first; the framework's own failures fill in
 * around them, and never over them — an author who documented `422`
 * himself has said something more specific than this could.
 */
function responses(
  entry: RouteTableEntry,
  options: AppOptions,
  contributed: HookContributions,
  components: SchemaComponents,
  warn: (message: string) => void,
): Record<string, ResponseObject> {
  const declared: Record<string, ResponseObject> = {};
  const response = entry.def.schema?.response;

  if (response && "~standard" in response) {
    declared["200"] = jsonResponse(
      response as AnySchema,
      "Successful response",
      warn,
    );
  } else if (response) {
    for (const [status, schema] of Object.entries(response)) {
      declared[status] =
        schema === null
          ? { description: describeStatus(status) }
          : jsonResponse(schema, describeStatus(status), warn);
    }
  }

  if (!declared["200"] && !hasSuccess(declared)) {
    declared["200"] = { description: "Successful response" };
  }

  return {
    ...declared,
    ...frameworkFailures(
      entry,
      options,
      contributed,
      declared,
      components,
      warn,
    ),
  };
}

function frameworkFailures(
  entry: RouteTableEntry,
  options: AppOptions,
  contributed: HookContributions,
  declared: Record<string, ResponseObject>,
  components: SchemaComponents,
  warn: (message: string) => void,
): Record<string, ResponseObject> {
  const schema = entry.def.schema;
  const failures = new Map<string, Failure[]>();

  const add = (status: number, failure: Failure): void => {
    const key = String(status);

    failures.set(key, [...(failures.get(key) ?? []), failure]);
  };

  /** Defines the envelope of one failure once, and refers to it. */
  const envelopeRef = (
    status: number,
    error?: string,
    message?: string,
  ): Record<string, unknown> =>
    components.ref(
      failureName(status, error),
      envelope(status, error, message),
    ) as unknown as Record<string, unknown>;

  if (schema?.params || schema?.query || schema?.headers || schema?.body) {
    add(options.validationStatus, {
      description: "Request failed schema validation",
      schema: components.ref(
        failureName(options.validationStatus, "VALIDATION_FAILED"),
        validationFailed(options.validationStatus),
      ) as unknown as Record<string, unknown>,
    });
  }

  for (const requirement of contributed.security) {
    const status = requirement.status ?? 401;

    add(status, {
      description:
        requirement.description ??
        `Request did not satisfy ${requirement.name}`,
      schema: envelopeRef(status, requirement.error, requirement.message),
    });
  }

  for (const response of contributed.responses) {
    const described = response.schema
      ? emitted(response.schema, "a hook's response", warn)
      : undefined;

    add(response.status, {
      description: response.description,
      schema:
        described ??
        envelopeRef(response.status, response.error, response.message),
    });
  }

  if (schema?.body || entry.def.bodyType) {
    const unparsable = parseFailure(entry.def.bodyType);

    if (unparsable) {
      add(400, {
        description: "Body could not be parsed in the declared shape",
        schema: envelopeRef(400, unparsable.error, unparsable.message),
      });
    }

    add(413, {
      description: "Body exceeded the configured size limit",
      schema: envelopeRef(
        413,
        "BODY_TOO_LARGE",
        "Body exceeds the configured limit",
      ),
    });
  }

  add(500, {
    description: "The request failed and nothing mapped the failure",
    schema: envelopeRef(500, "INTERNAL_SERVER_ERROR", "Internal Server Error"),
  });

  const responses: Record<string, ResponseObject> = {};

  for (const [status, list] of failures) {
    responses[status] = merge(declared[status], list);
  }

  return responses;
}

/** One way the framework itself can answer. */
interface Failure {
  readonly description: string;
  readonly schema: Record<string, unknown>;
}

/**
 * Folds everything that answers with one status into one response.
 *
 * Three things can meet on a status: what the route declared, and any
 * number of failures the framework fills in — a rejected schema and an
 * unparsable body collide on `400` as soon as an application configures
 * `validation: { status: 400 }`, and a route that answers `404` itself
 * shares that status with nothing while sharing `400` with the parser.
 *
 * All of them are true at once, so the document says so with an `anyOf`
 * rather than picking a winner. The route's own body comes first: it is
 * the answer the endpoint is about, and the failures are what can happen
 * to it. Identical bodies are folded together — a `$ref` repeated is one
 * alternative, not two.
 */
function merge(
  declared: ResponseObject | undefined,
  list: readonly Failure[],
): ResponseObject {
  const descriptions = [
    ...(declared ? [declared.description] : []),
    ...list.map((failure) => failure.description),
  ];

  const schemas = distinct([
    ...declaredSchemas(declared),
    ...list.map((failure) => failure.schema),
  ]);

  const [only] = schemas;

  return {
    description: descriptions.join("; "),
    ...(schemas.length === 1 && only
      ? { content: { "application/json": { schema: only } } }
      : { content: { "application/json": { schema: { anyOf: schemas } } } }),
  };
}

/**
 * The body a declared response describes, if it describes one: a response
 * whose schema could not be emitted contributes its description alone.
 */
function declaredSchemas(
  declared: ResponseObject | undefined,
): Record<string, unknown>[] {
  const schema = declared?.content?.["application/json"]?.schema;

  return schema ? [schema] : [];
}

function distinct(
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();

  return schemas.filter((schema) => {
    const fingerprint = JSON.stringify(schema);

    if (seen.has(fingerprint)) {
      return false;
    }

    seen.add(fingerprint);

    return true;
  });
}

function jsonResponse(
  schema: unknown,
  description: string,
  warn: (message: string) => void,
): ResponseObject {
  const described = emitted(schema, "a response", warn);

  if (!described) {
    return { description };
  }

  return {
    description,
    content: { "application/json": { schema: described } },
  };
}

function hasSuccess(declared: Record<string, ResponseObject>): boolean {
  return Object.keys(declared).some((status) => status.startsWith("2"));
}

function describeStatus(status: string): string {
  if (status === "204") {
    return "No content";
  }

  return status.startsWith("2") ? "Successful response" : `Response ${status}`;
}

/**
 * The body of one framework-produced failure, as JSON Schema.
 *
 * The status is a `const`, and so is the code whenever the framework knows
 * which one it will be: a generated client can then discriminate on
 * `error` instead of receiving "an object with three strings", and a
 * reader of the document sees `"BODY_TOO_LARGE"` rather than `string`.
 *
 * The message is documented by example, never as a `const` — it is wording
 * meant for a human, the one field a client must not match on, and the one
 * this project reserves the right to reword.
 */
function envelope(
  status: number,
  error?: string,
  message?: string,
): JsonSchemaObject {
  return {
    type: "object",
    required: ["status", "message", "error"],
    properties: {
      status: { type: "integer", const: status },
      message: message
        ? { type: "string", examples: [message] }
        : { type: "string" },
      error: error ? { type: "string", const: error } : { type: "string" },
    },
  };
}

/** The validation envelope: the standard three fields, plus the issues. */
function validationFailed(status: number): Record<string, unknown> {
  const base = envelope(status, "VALIDATION_FAILED", "Validation failed");

  return {
    ...base,
    required: ["status", "message", "error", "issues"],
    properties: {
      ...(base.properties as Record<string, unknown>),
      issues: {
        type: "array",
        items: {
          type: "object",
          required: ["message", "path"],
          properties: {
            message: { type: "string" },
            path: { type: "array", items: { type: ["string", "number"] } },
          },
        },
      },
    },
  };
}

/**
 * How a body of this type fails to parse — or nothing, for a text or a
 * stream body: one is whatever bytes arrived, the other is handed over
 * unread, and neither can be malformed.
 */
function parseFailure(
  bodyType: BodyType | undefined,
): { error: string; message: string } | undefined {
  if (bodyType === "text" || bodyType === "stream") {
    return undefined;
  }

  return bodyType === "form"
    ? { error: "MALFORMED_FORM", message: "Body is not a valid form" }
    : { error: "MALFORMED_JSON", message: "Body is not valid JSON" };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
