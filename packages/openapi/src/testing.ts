/**
 * Checking a response against the document, in a test.
 *
 * The document describes what every operation can answer; a test provokes
 * one answer. `assertDescribed` holds the two together: the status is
 * declared, the body is one the status describes, a header asked about is
 * documented. What it catches is what a client generated from the document
 * would trip over — an error code nobody declared, a field the schema says
 * is always there and is not.
 *
 * It checks only what a test provoked, which is why it can be strict: the
 * core does not compare a thrown error with the route's response map,
 * because a guard's refusal would be reported on every route it runs on;
 * a test that provoked the refusal asks about that one response.
 *
 * ```ts
 * import { assertDescribed } from "@tetsujs/openapi/testing";
 *
 * const { document } = openapi(app, { info });
 *
 * test("a wrong code is what the document says", async () => {
 *   const res = await request("/session", { method: "POST", body });
 *
 *   await assertDescribed(document, "POST /session", res);
 * });
 * ```
 *
 * @module
 */

import type { OpenApiDocument, ResponseObject } from "./document.ts";

/** What `assertDescribed` checks besides the status and the body's shape. */
export interface AssertDescribedOptions {
  /**
   * Checks the body against its schema in full, with the JSON Schema
   * validator of your choice — this package has none, and without one
   * only the top level is compared: required fields, fields that are a
   * `const`. Return `true` when the body is valid, or what is wrong.
   *
   * The schema stands on its own: every `$ref` into the document's
   * components points into its own `$defs`.
   *
   * @example
   * ```ts
   * const ajv = new Ajv2020();
   *
   * await assertDescribed(document, "POST /session", res, {
   *   validate: (schema, body) => ajv.validate(schema, body) || ajv.errorsText(),
   * });
   * ```
   */
  readonly validate?: (
    schema: Record<string, unknown>,
    body: unknown,
  ) => true | string;

  /**
   * Headers the status must declare when the response carries them —
   * `retry-after`. Only those named: a response carries headers no
   * document describes, `content-type` and `x-request-id` among them.
   */
  readonly headers?: readonly string[];
}

/**
 * Throws unless the response is one the document describes for the
 * operation, listing every way it is not.
 *
 * `request` names the operation as the test called it — a method and the
 * path it requested, `"GET /users/42"` — matched against the document's
 * path templates. The body is read from a clone, and the test can still
 * read the response.
 */
export async function assertDescribed(
  document: OpenApiDocument,
  request: string,
  response: Response,
  options: AssertDescribedOptions = {},
): Promise<void> {
  const problems = await problemsOf(document, request, response, options);

  if (problems.length > 0) {
    throw new Error(
      `${request} answered ${response.status}, which the document does not describe:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
}

async function problemsOf(
  document: OpenApiDocument,
  request: string,
  response: Response,
  options: AssertDescribedOptions,
): Promise<string[]> {
  const [method = "", target = ""] = request.split(" ");
  const path = target.split("?")[0] ?? "";
  const template = templateOf(document, path);
  const operation =
    template === undefined
      ? undefined
      : document.paths[template]?.[method.toLowerCase()];

  if (operation === undefined) {
    return [`there is no operation for ${method.toUpperCase()} ${path}`];
  }

  const status = String(response.status);
  const described = operation.responses[status];

  if (described === undefined) {
    return [
      `${status}, which the operation does not declare: it declares ${Object.keys(operation.responses).join(", ")}`,
    ];
  }

  return [
    ...(await bodyProblems(document, status, described, response, options)),
    ...headerProblems(status, described, response, options.headers ?? []),
  ];
}

/**
 * The path template a requested path belongs to: the one whose segments
 * match it, `{param}` matching any one segment. Of several, the one with
 * the most literal segments, as the router prefers `/users/me` to
 * `/users/{id}`; a template ending in a parameter also stands for a
 * wildcard, which matches the rest of the path.
 */
function templateOf(
  document: OpenApiDocument,
  path: string,
): string | undefined {
  const segments = path.split("/").filter(Boolean);

  let best: { template: string; literals: number } | undefined;

  for (const template of Object.keys(document.paths)) {
    const parts = template.split("/").filter(Boolean);
    const last = parts.at(-1) ?? "";
    const rest = isParameter(last) && segments.length > parts.length;

    if (parts.length !== segments.length && !rest) {
      continue;
    }

    let literals = 0;
    let matches = true;

    for (const [index, part] of parts.entries()) {
      if (isParameter(part)) {
        continue;
      }

      if (part !== segments[index]) {
        matches = false;

        break;
      }

      literals += 1;
    }

    if (matches && (best === undefined || literals > best.literals)) {
      best = { template, literals };
    }
  }

  return best?.template;
}

function isParameter(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

async function bodyProblems(
  document: OpenApiDocument,
  status: string,
  described: ResponseObject,
  response: Response,
  options: AssertDescribedOptions,
): Promise<string[]> {
  const text = await response.clone().text();
  const content = described.content ?? {};
  const mediaTypes = Object.keys(content);

  if (text === "") {
    return [];
  }

  if (mediaTypes.length === 0) {
    return [`a body, where its ${status} describes none`];
  }

  const mediaType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim();

  if (mediaType === undefined || !mediaTypes.includes(mediaType)) {
    return [
      `a body of type "${mediaType ?? ""}", where its ${status} describes ${mediaTypes.join(", ")}`,
    ];
  }

  const schema = content[mediaType]?.schema;

  if (schema === undefined || !mediaType.endsWith("json")) {
    return [];
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return [`a body that is not the JSON its ${status} describes`];
  }

  const problems = shapeProblems(document, status, schema, body);

  if (options.validate) {
    const verdict = options.validate(standalone(document, schema), body);

    if (verdict !== true) {
      problems.push(verdict);
    }
  }

  return problems;
}

/**
 * What the top level of a body gets wrong against every alternative its
 * status describes — nothing, when one of them fits. Named by the field
 * that tells the alternatives apart, when they have one: the code of an
 * envelope, compared with the codes the status lists.
 */
function shapeProblems(
  document: OpenApiDocument,
  status: string,
  schema: Record<string, unknown>,
  body: unknown,
): string[] {
  const alternatives = alternativesOf(document, schema);
  const misfits = alternatives.map((alternative) =>
    misfitOf(alternative, body),
  );

  if (misfits.some((misfit) => misfit === undefined)) {
    return [];
  }

  const field = tellingField(alternatives);

  if (field !== undefined && isRecord(body) && field in body) {
    const listed: unknown[] = alternatives
      .map((alternative) => constOf(propertiesOf(alternative)[field]))
      .filter((value) => value !== undefined);

    if (!listed.includes(body[field])) {
      return [
        `${field} ${JSON.stringify(body[field])}, which its ${status} does not list: ${listed.map(String).join(", ")}`,
      ];
    }
  }

  const reasons = [...new Set(misfits)];

  return [
    reasons.length === 1
      ? `a body that ${reasons[0]}`
      : `a body that fits none of the ${alternatives.length} its ${status} describes: ${reasons.join("; ")}`,
  ];
}

/** The alternatives a schema stands for, each `$ref` followed. */
function alternativesOf(
  document: OpenApiDocument,
  schema: SchemaView,
): SchemaView[] {
  const resolved = resolve(document, schema);
  const union = resolved.anyOf ?? resolved.oneOf;

  if (Array.isArray(union)) {
    return union.flatMap((branch) =>
      isRecord(branch) ? alternativesOf(document, branch) : [],
    );
  }

  return [resolved];
}

function resolve(document: OpenApiDocument, schema: SchemaView): SchemaView {
  const ref = schema.$ref;

  if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/")) {
    return schema;
  }

  const target =
    document.components?.schemas?.[ref.slice("#/components/schemas/".length)];

  return isRecord(target) ? target : schema;
}

/**
 * How a body fails one alternative at the top level, or `undefined` when
 * it does not: a required field missing, a `const` field different.
 */
function misfitOf(alternative: SchemaView, body: unknown): string | undefined {
  const properties = propertiesOf(alternative);
  const required = Array.isArray(alternative.required)
    ? (alternative.required as string[])
    : [];

  if (alternative.type === "object" || required.length > 0) {
    if (!isRecord(body)) {
      return "is not an object";
    }

    const missing = required.filter((name) => !(name in body));

    if (missing.length > 0) {
      return `lacks ${missing.join(", ")}`;
    }

    for (const [name, property] of Object.entries(properties)) {
      const expected = constOf(property);

      if (expected !== undefined && name in body && body[name] !== expected) {
        return `has ${name} ${JSON.stringify(body[name])} where it is ${JSON.stringify(expected)}`;
      }
    }
  }

  return undefined;
}

/**
 * The field whose `const` differs from one alternative to the next — the
 * code of an envelope — or none.
 */
function tellingField(alternatives: readonly SchemaView[]): string | undefined {
  const [first] = alternatives;

  if (first === undefined) {
    return undefined;
  }

  return Object.keys(propertiesOf(first)).find(
    (name) =>
      name !== "status" &&
      alternatives.every(
        (alternative) =>
          typeof constOf(propertiesOf(alternative)[name]) === "string",
      ),
  );
}

function propertiesOf(schema: SchemaView): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

function constOf(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  const property: SchemaView = value;

  if ("const" in property) {
    return property.const;
  }

  return Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
}

/**
 * A schema that needs nothing but itself: the document's components as its
 * `$defs`, and every reference into them pointed there — what a validator
 * that knows JSON Schema and not OpenAPI can compile.
 */
function standalone(
  document: OpenApiDocument,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const repoint = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(repoint);
    }

    if (!isRecord(value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === "$ref" && typeof inner === "string"
          ? inner.replace("#/components/schemas/", "#/$defs/")
          : repoint(inner),
      ]),
    );
  };

  return {
    ...(repoint(schema) as Record<string, unknown>),
    $defs: repoint(document.components?.schemas ?? {}),
  };
}

function headerProblems(
  status: string,
  described: ResponseObject,
  response: Response,
  names: readonly string[],
): string[] {
  const declared = Object.keys(described.headers ?? {}).map((name) =>
    name.toLowerCase(),
  );

  return names
    .filter(
      (name) =>
        response.headers.has(name) && !declared.includes(name.toLowerCase()),
    )
    .map(
      (name) => `the header "${name}", which its ${status} does not declare`,
    );
}

/**
 * A schema as this module reads it: any keyword, with the ones it looks
 * into named, so reading them does not depend on the reader's
 * `noPropertyAccessFromIndexSignature`.
 */
interface SchemaView {
  readonly $ref?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly type?: unknown;
  readonly required?: unknown;
  readonly properties?: unknown;
  readonly const?: unknown;
  readonly enum?: unknown;
  readonly [keyword: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
