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
  ResponseEntry,
  RouteTableEntry,
} from "@tetsujs/core";
import { errorBody } from "@tetsujs/core";
import type {
  DocumentedResponse,
  HookContributions,
  SecurityRequirement,
} from "./annotations.ts";
import { contributionsOf } from "./annotations.ts";
import type { SchemaComponents } from "./components.ts";
import { failureName } from "./components.ts";
import type {
  ContentMap,
  HeaderObject,
  OperationObject,
  ResponseObject,
} from "./document.ts";
import type { JsonSchemaObject } from "./emit.ts";
import { emitted } from "./emit.ts";
import type { Envelopes } from "./envelopes.ts";
import { branchesOf } from "./envelopes.ts";
import type { JsonSchema } from "./json-schema.ts";
import { partParameters, pathParameters } from "./parameters.ts";

/** Describes one route. */
export function operationOf(
  entry: RouteTableEntry,
  options: AppOptions,
  components: SchemaComponents,
  envelopes: Envelopes,
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
      ? { security: securityOf(contributed.conditions) }
      : {}),
    responses: responses(
      entry,
      options,
      contributed,
      components,
      envelopes,
      warn,
    ),
  };
}

/**
 * Records the envelopes a route declares, so that its definitions are the
 * ones the document keeps — whichever operation refers to them first.
 *
 * Runs before any operation is built. A schema that cannot describe itself
 * is skipped without a word: building the operation says so, once.
 */
export function declareEnvelopes(
  entry: RouteTableEntry,
  envelopes: Envelopes,
): void {
  for (const [status, { body }] of declaredResponses(entry)) {
    const described = body === null ? undefined : emitted(body, "", () => {});

    const code = envelopes.format.code;

    for (const branch of described ? branchesOf(described, code) : []) {
      const found = code(branch);

      if (found !== undefined) {
        envelopes.declare(Number(status), found, branch);
      }
    }
  }
}

/** One status of a route's response map, whichever form it was written in. */
interface Declared {
  readonly body: AnySchema | null;
  readonly headers?: AnySchema;
  readonly cookies?: AnySchema;
}

/** The route's response map as pairs; a single schema is its `200`. */
function declaredResponses(
  entry: RouteTableEntry,
): [status: string, declared: Declared][] {
  const response = entry.def.schema?.response;

  if (!response) {
    return [];
  }

  if ("~standard" in response) {
    return [["200", { body: response as AnySchema }]];
  }

  return Object.entries(response).map(([status, value]) => [
    status,
    asDeclared(value as AnySchema | ResponseEntry | null),
  ]);
}

function asDeclared(value: AnySchema | ResponseEntry | null): Declared {
  if (value === null || "~standard" in value) {
    return { body: value as AnySchema | null };
  }

  return {
    body: value.body ?? null,
    ...(value.headers === undefined ? {} : { headers: value.headers }),
    ...(value.cookies === undefined ? {} : { cookies: value.cookies }),
  };
}

/**
 * The headers a declared status says it leaves with: one per property of
 * its `headers` schema, required as the schema says, and its cookies as
 * the one header that sets them.
 *
 * A property's `description` is the header's: it is what a renderer
 * shows in the header's row.
 */
function declaredHeaders(
  declared: Declared,
  warn: (message: string) => void,
): Record<string, HeaderObject> | undefined {
  const headers: Record<string, HeaderObject> = {};

  const [properties, required] = shapeOf(
    declared.headers,
    "a response's headers",
    warn,
  );

  for (const [name, property] of Object.entries(properties)) {
    const { description, ...schema } = property;

    headers[name] = {
      ...(typeof description === "string" ? { description } : {}),
      ...(required.has(name) ? { required: true } : {}),
      schema: schema as JsonSchema,
    };
  }

  const cookies = setCookie(declared.cookies, warn);

  if (cookies) {
    headers["set-cookie"] = cookies;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * The cookies a status sets, as the header that sets them. OpenAPI has no
 * object for a cookie a response sets — only a `set-cookie` header — so the
 * cookies are listed in its description, by name, each with its own
 * description; the header is required when any of them is.
 */
function setCookie(
  schema: AnySchema | undefined,
  warn: (message: string) => void,
): HeaderObject | undefined {
  const [properties, required] = shapeOf(schema, "a response's cookies", warn);

  const names = Object.keys(properties);

  if (names.length === 0) {
    return undefined;
  }

  const lines = names.map((name) => {
    const description = properties[name]?.["description"];

    return typeof description === "string"
      ? `- \`${name}\`: ${description}`
      : `- \`${name}\``;
  });

  return {
    description: ["Sets these cookies:", "", ...lines].join("\n"),
    ...(required.size > 0 ? { required: true } : {}),
    schema: { type: "string" },
  };
}

/**
 * The properties of an object schema, and which of them it requires.
 *
 * Read as the schema's input: a response's headers and cookies are checked
 * against it and sent as the handler set them, not as the schema returns
 * them — unlike a body, whose checked value is what gets serialized. A
 * field with a default is one the handler may leave out, and the response
 * then leaves without it.
 */
function shapeOf(
  schema: AnySchema | undefined,
  subject: string,
  warn: (message: string) => void,
): [Record<string, Record<string, unknown>>, Set<string>] {
  const described = schema
    ? emitted(schema, subject, warn, "input")
    : undefined;

  const properties = (described?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const required = new Set(
    Array.isArray(described?.required) ? (described.required as string[]) : [],
  );

  return [properties, required];
}

/**
 * A described body as the alternatives the document lists: every envelope
 * in it a reference to the one definition of its status and code, and a
 * union taken apart into its branches, so that it joins the other answers
 * of its status rather than nesting inside them.
 */
function branchesFor(
  schema: JsonSchemaObject,
  status: number,
  envelopes: Envelopes,
  warn: (message: string) => void,
): Record<string, unknown>[] {
  return branchesOf(schema, envelopes.format.code).map((branch) => {
    const code = envelopes.format.code(branch);

    return code === undefined
      ? branch
      : (envelopes.ref(status, code, branch, warn) as unknown as Record<
          string,
          unknown
        >);
  });
}

/**
 * The security a route asks for, as OpenAPI spells it.
 *
 * OpenAPI reads the entries of an operation's `security` as alternatives —
 * any one of them authorizes a request — and the schemes inside one entry
 * as all required. A route's conditions are the other way round: every
 * hook runs, so every condition is required, and a condition is satisfied
 * by any one of its alternatives. The entries are therefore the
 * combinations — one alternative from each condition, taken together:
 * a hook accepting a cookie *or* a token, next to a CSRF check, is
 * `[{ cookie, csrf }, { token, csrf }]`. With no alternatives anywhere
 * that is a single entry holding every scheme, which is the usual case.
 *
 * Two alternatives of one scheme in a combination ask for the scopes of
 * both; a combination that comes out twice is listed once.
 */
function securityOf(
  conditions: readonly (readonly SecurityRequirement[])[],
): Record<string, readonly string[]>[] {
  let combinations: Record<string, readonly string[]>[] = [{}];

  for (const alternatives of conditions) {
    combinations = combinations.flatMap((combination) =>
      alternatives.map((requirement) => ({
        ...combination,
        [requirement.name]: joined(
          combination[requirement.name],
          requirement.scopes,
        ),
      })),
    );
  }

  const seen = new Set<string>();

  return combinations.filter((combination) => {
    const key = JSON.stringify(
      Object.entries(combination)
        .map(([name, scopes]) => [name, [...scopes].sort()])
        .sort(),
    );

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/** The scopes of a scheme already in a combination, and another's. */
function joined(
  present: readonly string[] | undefined,
  added: readonly string[] | undefined,
): readonly string[] {
  const scopes = [...(present ?? [])];

  for (const scope of added ?? []) {
    if (!scopes.includes(scope)) {
      scopes.push(scope);
    }
  }

  return scopes;
}

/**
 * Hands out the `operationId` of every route in one document.
 *
 * An `operationId` is a contract: a generated client names its methods
 * after them, so an id that moves breaks code nobody reviewing the change
 * sees. The id is therefore always stated or derived from names the
 * author wrote — never from where a route happened to land:
 *
 * | | |
 * | --- | --- |
 * | `docs.operationId` on the route | taken as written |
 * | a route of a named controller | the name and the field — `authRequestCode` |
 * | a route of an unnamed object | the field — `requestCode` |
 * | a route mounted standalone | its method and path — `postAuthCode` |
 *
 * Two routes arriving at one id is an error, not something to route
 * around. Falling back to the method and path, or numbering the second
 * one, would hand one of them an id that changes when a path is edited or
 * a route is added — silently, in someone else's SDK. The error names
 * both routes and the two ways out: a controller name of its own, or an
 * id stated on the route. The core already refuses two controllers of
 * one name; what reaches this is two stated ids, or a stated id meeting a
 * derived one.
 */
export interface OperationIds {
  /** The id for this route, unique within the document being built. */
  take(entry: RouteTableEntry): string;
}

export function operationIds(): OperationIds {
  const taken = new Map<string, RouteTableEntry>();

  return {
    take(entry: RouteTableEntry): string {
      const id = idOf(entry);
      const holder = taken.get(id);

      if (holder !== undefined) {
        throw new Error(
          `operationId "${id}" is taken by both ${describe(holder)} and ${describe(entry)} — a generated client would get one method for two operations. Give one of them docs.operationId, or its controller a name of its own.`,
        );
      }

      taken.set(id, entry);

      return id;
    },
  };
}

/** The id a route asks for, before anything checks it is free. */
function idOf(entry: RouteTableEntry): string {
  const stated = entry.def.docs?.operationId;

  if (stated !== undefined) {
    return stated;
  }

  if (entry.name === undefined) {
    return derivedId(entry);
  }

  if (entry.controller === undefined) {
    return entry.name;
  }

  const controller = entry.controller.replace(/Controller$/, "");

  return `${lowerFirst(controller)}${capitalize(entry.name)}`;
}

/** How the error above names a route: the one line that finds it. */
function describe(entry: RouteTableEntry): string {
  return `${entry.method} ${entry.path}`;
}

/**
 * What a route mounted standalone is named by: it has no field and no
 * controller, and its method and path are what it has.
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

  /**
   * A body is read when the core reads one: a schema, a declared shape, or
   * `rawBody` — which parses JSON as any body does, next to keeping its
   * bytes. Without a schema the document says what the body is, not what
   * is in it.
   */
  const bodyType =
    entry.def.bodyType ?? (declared || entry.def.rawBody ? "json" : undefined);

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
  envelopes: Envelopes,
  warn: (message: string) => void,
): Record<string, ResponseObject> {
  const answers = new Map<string, Answer[]>();

  const add = (status: string, answer: Answer): void => {
    answers.set(status, [...(answers.get(status) ?? []), answer]);
  };

  const declared = declaredResponses(entry);

  for (const [status, { body, ...rest }] of declared) {
    const described =
      body === null ? undefined : emitted(body, "a response", warn);

    const headers = declaredHeaders({ body, ...rest }, warn);

    add(status, {
      placeholder: describeStatus(status),
      said: described ? wordsOf(described, envelopes) : [],
      schemas: described
        ? branchesFor(unionOnly(described), Number(status), envelopes, warn)
        : [],
      ...(headers === undefined ? {} : { headers }),
    });
  }

  /**
   * A route that declares nothing answers with something: a `200`, as far
   * as the document can tell. One that declares only a `303`, or only its
   * failures, has said what it answers with, and a success it never sends
   * would be a response a generated client waits for in vain.
   */
  if (declared.length === 0) {
    add("200", { placeholder: "Successful response", said: [], schemas: [] });
  }

  for (const [status, answer] of failures(
    entry,
    options,
    contributed,
    components,
    envelopes,
    warn,
  )) {
    add(String(status), answer);
  }

  const described: Record<string, ResponseObject> = {};

  for (const [status, list] of answers) {
    described[status] = merge(list, envelopes);
  }

  return described;
}

/**
 * Everything the route can answer with that its own schema does not say:
 * what its hooks declare, and what the framework itself answers.
 */
function failures(
  entry: RouteTableEntry,
  options: AppOptions,
  contributed: HookContributions,
  components: SchemaComponents,
  envelopes: Envelopes,
  warn: (message: string) => void,
): [status: number, answer: Answer][] {
  const schema = entry.def.schema;
  const found: [number, Answer][] = [];

  /**
   * Refers to the definition of one failure: the one of its status and
   * code, or — for a failure whose code only the hook knows and did not
   * declare — one of its own, named after the status.
   */
  const envelopeRef = (
    status: number,
    error?: string,
    message?: string,
    fields?: DocumentedResponse["fields"],
  ): Record<string, unknown> => {
    const described = envelopes.format.describe({
      status,
      ...(error === undefined ? {} : { error }),
      ...(message === undefined ? {} : { message }),
      fields: fields ?? {},
    });

    const ref =
      error === undefined
        ? components.ref(failureName(status), described)
        : envelopes.ref(status, error, described, warn);

    return ref as unknown as Record<string, unknown>;
  };

  if (
    schema?.params ||
    schema?.query ||
    schema?.headers ||
    schema?.cookies ||
    schema?.body
  ) {
    found.push([
      options.validationStatus,
      {
        said: [
          {
            code: "VALIDATION_FAILED",
            text: "Request failed schema validation",
          },
        ],
        schemas: [
          envelopes.ref(
            options.validationStatus,
            "VALIDATION_FAILED",
            envelopes.format.describe({
              status: options.validationStatus,
              error: "VALIDATION_FAILED",
              message: "Validation failed",
              fields: { issues },
            }),
            warn,
          ) as unknown as Record<string, unknown>,
        ],
      },
    ]);
  }

  for (const requirement of contributed.security) {
    const status = requirement.status ?? 401;

    found.push([
      status,
      {
        said: [
          said(
            requirement.error,
            requirement.description ??
              `Request did not satisfy ${requirement.name}`,
          ),
        ],
        schemas: [envelopeRef(status, requirement.error, requirement.message)],
      },
    ]);
  }

  for (const response of contributed.responses) {
    const described = response.schema
      ? emitted(response.schema, "a hook's response", warn)
      : undefined;

    found.push([
      response.status,
      {
        said: [said(response.error, response.description)],
        schemas: described
          ? branchesFor(described, response.status, envelopes, warn)
          : [
              envelopeRef(
                response.status,
                response.error,
                response.message,
                response.fields,
              ),
            ],
        ...(response.headers ? { headers: response.headers } : {}),
      },
    ]);
  }

  if (schema?.body || entry.def.bodyType || entry.def.rawBody) {
    const unparsable = parseFailure(entry.def.bodyType);

    if (unparsable) {
      found.push([
        400,
        {
          said: [
            said(
              unparsable.error,
              "Body could not be parsed in the declared shape",
            ),
          ],
          schemas: [envelopeRef(400, unparsable.error, unparsable.message)],
        },
      ]);
    }

    found.push([
      413,
      {
        said: [
          said("BODY_TOO_LARGE", "Body exceeded the configured size limit"),
        ],
        schemas: [
          envelopeRef(
            413,
            "BODY_TOO_LARGE",
            "Body exceeds the configured limit",
          ),
        ],
      },
    ]);
  }

  found.push([
    500,
    {
      said: [
        said(
          "INTERNAL_SERVER_ERROR",
          "The request failed and nothing mapped the failure",
        ),
      ],
      schemas: [
        envelopeRef(500, "INTERNAL_SERVER_ERROR", "Internal Server Error"),
      ],
    },
  ]);

  return found;
}

/**
 * One way a route can answer with a status: what the route declared, what
 * a hook declared, or what the framework answers by itself.
 *
 * `schemas` are the alternatives of the body, each envelope already a
 * reference to its definition; empty when the answer has no body to
 * describe.
 *
 * `said` is what the answer says about itself, with the code each part is
 * about when it is known: a hook's description, the framework's, what a
 * route's schema says. A route whose schema says nothing has only its
 * `placeholder` — the reason phrase — which stands for the status when
 * nothing else describes it.
 */
interface Answer {
  readonly said: readonly Said[];
  readonly placeholder?: string;
  readonly schemas: readonly Record<string, unknown>[];
  readonly headers?: Readonly<Record<string, HeaderObject>>;
}

/** One description, and the code it describes when that is known. */
interface Said {
  readonly code?: string;
  readonly text: string;
}

function said(code: string | undefined, text: string): Said {
  return code === undefined ? { text } : { code, text };
}

/**
 * What a route's schema says about the status it is declared for: its own
 * `description`, or — for a union that has none — each branch's, with the
 * branch's code. A schema that says nothing says nothing here either.
 */
function wordsOf(schema: JsonSchemaObject, envelopes: Envelopes): Said[] {
  if (typeof schema.description === "string") {
    return [said(envelopes.format.code(schema), schema.description)];
  }

  return branchesOf(unionOnly(schema), envelopes.format.code).flatMap(
    (branch) =>
      typeof branch.description === "string"
        ? [said(envelopes.format.code(branch), branch.description)]
        : [],
  );
}

/**
 * A union without the `description` it carried as a whole — which says
 * what the status is, and is used as the status's description — so its
 * branches can join the status's own alternatives. Anything but a union
 * is kept as it is, its description included, for its definition.
 */
function unionOnly(schema: JsonSchemaObject): JsonSchemaObject {
  if (
    typeof schema.description !== "string" ||
    (!Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf))
  ) {
    return schema;
  }

  const { description: _, ...union } = schema;

  return union;
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
 *
 * Headers are gathered the same way, the first description of a name
 * standing for all of them; descriptions as {@link wording} words them.
 */
function merge(list: readonly Answer[], envelopes: Envelopes): ResponseObject {
  const schemas = distinct(list.flatMap((answer) => answer.schemas));
  const headers: Record<string, HeaderObject> = {};

  for (const answer of list) {
    for (const [name, header] of Object.entries(answer.headers ?? {})) {
      headers[name] ??= header;
    }
  }

  return {
    description: wording(list),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(schemas.length > 0
      ? {
          content: {
            "application/json": { schema: unionOf(schemas, envelopes) },
          },
        }
      : {}),
  };
}

/**
 * The description of a status, from everything that answers with it.
 *
 * One thing said is the description. Several are a list, each item led
 * by the code it is about, so a reader sees which description goes with
 * which code — descriptions are CommonMark, and every renderer draws the
 * list. The same code said the same way twice, by the route and a hook,
 * is one item. With nothing said at all, the route's placeholder stands.
 */
function wording(list: readonly Answer[]): string {
  const seen = new Set<string>();
  const items: Said[] = [];

  for (const answer of list) {
    for (const item of answer.said) {
      const key = `${item.code ?? ""}\n${item.text}`;

      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }

  const [only] = items;

  if (items.length === 1 && only) {
    return only.text;
  }

  if (items.length > 1) {
    return items
      .map((item) =>
        item.code === undefined
          ? `- ${item.text}`
          : `- \`${item.code}\`: ${item.text}`,
      )
      .join("\n");
  }

  return list.find((answer) => answer.placeholder)?.placeholder ?? "";
}

/**
 * The alternatives of a body as one schema.
 *
 * When every alternative is an envelope, each with its own code, the union
 * says so with a `discriminator` on `error`: a generated client then
 * builds a tagged union and narrows on the code, instead of trying the
 * shapes in turn. The mapping is spelled out, because without it OpenAPI
 * matches the value against the component's name — `Unauthorized`, where
 * the body says `UNAUTHORIZED`. The field is the error format's; a format
 * that names none — its code nested below the top — has no discriminator.
 */
function unionOf(
  schemas: readonly Record<string, unknown>[],
  envelopes: Envelopes,
): Record<string, unknown> {
  const [only] = schemas;

  if (schemas.length === 1 && only) {
    return only;
  }

  const propertyName = envelopes.format.discriminator;

  if (propertyName === undefined) {
    return { anyOf: schemas };
  }

  const mapping: Record<string, string> = {};

  for (const schema of schemas) {
    const ref = (schema as { $ref?: unknown }).$ref;
    const code = typeof ref === "string" ? envelopes.codeOf(ref) : undefined;

    if (typeof ref !== "string" || code === undefined) {
      return { anyOf: schemas };
    }

    mapping[code] = ref;
  }

  return {
    anyOf: schemas,
    discriminator: { propertyName, mapping },
  };
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

function describeStatus(status: string): string {
  if (status === "204") {
    return "No content";
  }

  return status.startsWith("2")
    ? "Successful response"
    : errorBody(Number(status)).message;
}

/**
 * What a validation failure carries besides the code and the message: every
 * issue, with where it is. Handed to the error format as a field, for the
 * format to place.
 */
const issues: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["message", "path"],
    properties: {
      message: { type: "string" },
      path: { type: "array", items: { type: ["string", "number"] } },
    },
  },
};

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
