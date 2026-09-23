/**
 * TypeBox adapter: turns a TypeBox schema into a DTO the framework accepts
 * directly, without giving up TypeBox's compiled validation speed.
 *
 * `tb()` compiles the schema once, at declaration time, and attaches the
 * Standard Schema interface as a non-enumerable property. The result is
 * dual-natured: still a plain JSON Schema object (serializes clean, nests
 * into other TypeBox schemas, feeds OpenAPI as-is) and at the same time a
 * validator the core can call.
 *
 * @example
 * ```ts
 * import { Type, tb } from "@tetsujs/typebox";
 *
 * export const CreateUser = tb(
 *   Type.Object({
 *     name: Type.String({ minLength: 1 }),
 *     email: Type.String({ format: "email" }),
 *   }),
 * );
 *
 * export const UserParams = tb(Type.Object({ id: Type.Number() }), {
 *   convert: true,
 * });
 *
 * route({
 *   method: "POST",
 *   path: "/users/:id",
 *   schema: { params: UserParams, body: CreateUser },
 *   handler: (ctx) => users.update(ctx.params.id, ctx.body),
 *   //                              ^? number      ^? { name: string; email: string }
 * });
 * ```
 *
 * @module
 */

import type {
  StandardIssue,
  StandardJSONSchemaOptions,
  StandardJSONSchemaV1,
  StandardResult,
  StandardSchemaV1,
} from "@tetsujs/core";
import { ValidationError } from "@tetsujs/core";
import { type StaticDecode, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import Value from "typebox/value";
import { fileDocs } from "./file.ts";

/**
 * TypeBox's own builder and types, so a DTO module imports from one place:
 * `import { Type, tb } from "@tetsujs/typebox"`.
 *
 * Re-exported, not wrapped: `Type` is the object `typebox` exports, and
 * its documentation applies as it is. TypeBox stays a peer dependency, so
 * the application chooses its version and there is one copy of it.
 */
export type { Static, StaticDecode, TSchema } from "typebox";
export { Type } from "typebox";
export type { FileOptions, FileSize } from "./file.ts";
export { file, files } from "./file.ts";

/**
 * JSON Schema dialects this adapter emits.
 *
 * TypeBox schemas are JSON Schema 2020-12, which OpenAPI 3.1 adopts
 * verbatim — both targets return the schema unchanged. Older dialects
 * differ in ways that cannot be papered over silently, so requesting one
 * throws instead of producing subtly wrong documentation.
 */
export const supportedTargets = ["draft-2020-12", "openapi-3.1"] as const;

/**
 * Options controlling how a TypeBox DTO validates.
 */
export interface TypeBoxOptions {
  /**
   * Coerce input before checking (`Value.Convert`): `"42"` becomes `42`,
   * `"true"` becomes `true`.
   *
   * Required for `params`, `query` and `headers`, whose values always
   * arrive as strings. Off by default — coercion is never implicit.
   *
   * The validated value is a clone: TypeBox coerces in place, and on a
   * `response` schema the argument is the object the handler returned.
   */
  readonly convert?: boolean;

  /**
   * Strip properties the schema does not declare (`Value.Clean`).
   *
   * The barrier against leaking extra fields through a `response` DTO,
   * where structural typing alone cannot help.
   *
   * The validated value is a clone: TypeBox strips in place, so without a
   * copy the first response would delete the undeclared fields from the
   * handler's own object — a cached entity or a store record.
   */
  readonly clean?: boolean;

  /**
   * Fill in the `default` a schema declares for a value that is absent
   * (`Value.Default`).
   *
   * Off by default, like every other mutation: a body that omits a field
   * and a body that sends the default are different requests, and only the
   * author knows whether the difference matters. Where it does not — a
   * `limit` on a query, a port in an environment — this is what spares the
   * handler a `?? 20`.
   *
   * Runs before coercion, so a default is checked exactly like a value
   * that arrived.
   *
   * Also changes what the schema says, not only what it accepts: a
   * property with a `default` is left out of `required` in the emitted
   * input schema, since the client need not send it.
   */
  readonly defaults?: boolean;

  /** Vendor name reported in the Standard Schema interface. */
  readonly vendor?: string;

  /**
   * How a value that fails is described: `"detailed"` (the default) lists
   * each failure at its path, with the messages the schema declares;
   * `"summary"` reports one failure for the whole value, with no path.
   *
   * The compiled check says *invalid* in nanoseconds; saying *where* is
   * TypeBox's `Errors()`, which walks the value uncompiled and costs in
   * proportion to how much valid data lies before the failure — 14 µs for
   * one bad line at the end of a twenty-line order, a few times what the
   * whole request costs otherwise. It has no mode that stops at the first
   * failure. `"summary"` does not call it at all.
   *
   * For a large body on an endpoint open to anyone, where the sender of a
   * malformed payload is owed a `422` and nothing more.
   */
  readonly issues?: "detailed" | "summary";
}

/**
 * The one failure a `"summary"` DTO reports, shared: nothing in it depends
 * on the value.
 */
const summaryIssues: readonly StandardIssue[] = [
  { message: "does not match the schema" },
];

/**
 * A TypeBox schema that is also a Standard Schema validator and a JSON
 * Schema source — the return type of {@link tb}.
 *
 * The validated type is the *decoded* one. For a plain schema that is the
 * schema's own type; for one built with `Type.Codec` it is what the codec
 * produces — a `Date` where the wire carries a string — because decoding
 * is what `validate` does with a value that checks out.
 */
export type TypeBoxSchema<T extends TSchema> = T &
  StandardSchemaV1<unknown, StaticDecode<T>> &
  StandardJSONSchemaV1<unknown, StaticDecode<T>>;

/**
 * Adapts a TypeBox schema for use as a route DTO.
 *
 * Compilation happens here, once per declaration — the request path only
 * runs the compiled checker. The input schema is left untouched; the
 * returned value is a shallow copy carrying the adapter interface.
 *
 * Validated values are left untouched too: `convert` and `clean` are
 * in-place operations in TypeBox, so a schema declaring either one clones
 * its input before validating.
 *
 * A DTO already adapted can be adapted again, and the options passed are
 * the complete set: nothing carries over from the earlier call, so an
 * option it turned on and this one omits is off.
 *
 * @example Coercing path parameters
 * ```ts
 * const Params = tb(Type.Object({ id: Type.Integer() }), { convert: true });
 * ```
 *
 * @example Reading an environment, where everything arrives as a string
 * ```ts
 * const Env = tb(Type.Object({ PORT: Type.Integer({ default: 3000 }) }), {
 *   convert: true,
 *   defaults: true,
 *   clean: true,
 * });
 * ```
 *
 * @example Stripping unknown fields from a response
 * ```ts
 * const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });
 * ```
 *
 * @example A message of your own, instead of TypeBox's wording
 * ```ts
 * const Password = tb(
 *   Type.String({ minLength: 8, errorMessage: "At least 8 characters" }),
 * );
 * ```
 */
export function tb<T extends TSchema>(
  schema: T,
  options: TypeBoxOptions = {},
): TypeBoxSchema<T> {
  const compiled = Compile(schema);
  const {
    convert = false,
    clean = false,
    defaults = false,
    vendor = "typebox",
    issues = "detailed",
  } = options;

  /**
   * The copy the adapter hands back.
   *
   * Descriptors rather than a spread: TypeBox keeps its own bookkeeping on
   * a schema in non-enumerable properties (`~kind`, and the codec markers
   * under it), and a spread silently drops them — leaving an object that
   * still looks like a JSON Schema and still validates through this
   * adapter, but that `Value.Encode` and every other `Value.*` entry point
   * refuses. Copying descriptors keeps the schema whole and keeps those
   * properties non-enumerable, so serializing the DTO still produces plain
   * JSON Schema.
   *
   * All but one: a DTO wrapped again — to change its options, say — already
   * carries the interface this call is about to attach, and its descriptor
   * is fixed. Copied, it would make the new one impossible to define.
   */
  const { "~standard": _previous, ...descriptors } =
    Object.getOwnPropertyDescriptors(schema) as PropertyDescriptorMap;

  const adapted = Object.create(
    Object.getPrototypeOf(schema) as object | null,
    descriptors,
  ) as TypeBoxSchema<T>;

  /**
   * The schema as documentation, in the direction being asked about.
   *
   * The two directions differ in exactly one place, and only with
   * `defaults`. A property carrying a `default` is one the adapter fills
   * in when it is missing, so the client does not have to send it: on the
   * way in it is not required, whatever the schema says. On the way out it
   * is — the value is there by the time the response is built. Saying
   * `required` in both directions describes a parameter the server
   * happily answers without, and a generated client would demand it.
   *
   * The other two options leave the description alone, and should:
   * `convert` widens what is accepted without changing the shape, and
   * `clean` strips unknown properties rather than refusing them, which is
   * what an absent `additionalProperties` already says.
   */
  const jsonSchema =
    (direction: "input" | "output") =>
    (target: StandardJSONSchemaOptions): Record<string, unknown> => {
      if (!isSupportedTarget(target.target)) {
        throw new Error(
          `@tetsujs/typebox emits ${supportedTargets.join(" / ")}; target "${target.target}" is not supported`,
        );
      }

      const described = documented(schema) as Record<string, unknown>;

      return defaults && direction === "input"
        ? withoutFilledDefaults(described)
        : described;
    };

  const mutatesInput = convert || clean || defaults;
  const decodes = hasCodec(schema);

  const validate = (value: unknown): StandardResult<StaticDecode<T>> => {
    const owned = mutatesInput ? Value.Clone(value) : value;
    const filled = defaults ? Value.Default(schema, owned) : owned;
    const candidate = convert ? Value.Convert(schema, filled) : filled;

    if (!compiled.Check(candidate)) {
      return {
        issues:
          issues === "summary"
            ? summaryIssues
            : collectIssues(compiled.Errors(candidate), schema),
      };
    }

    const checked = clean ? Value.Clean(schema, candidate) : candidate;

    return {
      value: (decodes ? compiled.Decode(checked) : checked) as StaticDecode<T>,
    };
  };

  Object.defineProperty(adapted, "~standard", {
    enumerable: false,
    value: {
      version: 1,
      vendor,
      validate,
      jsonSchema: { input: jsonSchema("input"), output: jsonSchema("output") },
    },
  });

  return adapted;
}

/**
 * Reports whether any node of the schema transforms its input.
 *
 * Decoding costs a second traversal of the value, so it runs only for the
 * schemas that ask for one — `files()`, which normalizes a lone file into
 * an array, and any codec a user wrote. The walk happens once, when the
 * DTO is declared.
 */
function hasCodec(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasCodec);
  }

  if (node === null || typeof node !== "object") {
    return false;
  }

  if (Type.IsCodec(node)) {
    return true;
  }

  return Object.values(node).some(hasCodec);
}

/**
 * Produces the documentation shape of a schema.
 *
 * A plain schema is already its own JSON Schema and is copied as-is; a
 * file schema is not — it validates through refinements and carries the
 * binary shape apart, because a `type: "string"` on the validated schema
 * would reject the `File` it describes. The tree is walked because a file
 * is a field of a form, never the whole body.
 */
function documented(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(documented);
  }

  if (node === null || typeof node !== "object") {
    return node;
  }

  const docs = fileDocs(node);

  if (docs) {
    return { ...docs };
  }

  const copy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key !== messageKeyword) {
      copy[key] = documented(value);
    }
  }

  return copy;
}

/**
 * Drops from every `required` list the properties that carry a `default`.
 *
 * Walked with a stack rather than by recursion, and remembering what it
 * has seen: the depth of a schema is its author's to choose, and a `$ref`
 * that leads back on itself would otherwise never return.
 *
 * Rewrites in place, which is safe only because `documented()` hands back
 * a fresh deep copy — the schema the caller declared is never touched. It
 * is the same rule the rest of this adapter follows for values.
 */
function withoutFilledDefaults(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const pending: unknown[] = [root];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const node = pending.pop();

    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }

    seen.add(node);

    const shape = node as {
      properties?: unknown;
      required?: unknown;
      [keyword: string]: unknown;
    };
    const properties = shape.properties;

    if (
      Array.isArray(shape.required) &&
      properties !== null &&
      typeof properties === "object"
    ) {
      const asked = (shape.required as unknown[]).filter((key) => {
        const property = (properties as Record<string, unknown>)[String(key)];

        return !(
          property !== null &&
          typeof property === "object" &&
          "default" in property
        );
      });

      if (asked.length > 0) {
        shape.required = asked;
      } else {
        delete shape.required;
      }
    }

    for (const value of Object.values(shape)) {
      pending.push(value);
    }
  }

  return root;
}

function isSupportedTarget(target: string): boolean {
  return (supportedTargets as readonly string[]).includes(target);
}

/**
 * The part of a TypeBox error this adapter reads.
 *
 * `params` is declared open rather than as the union TypeBox exports:
 * every keyword carries its own shape there, and the two this module
 * looks at are read defensively anyway. Those two are named, so reading
 * them does not depend on `noPropertyAccessFromIndexSignature`.
 */
interface TypeBoxError {
  readonly message: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword?: string;
  readonly params?: Readonly<{
    requiredProperties?: unknown;
    additionalProperties?: unknown;
    [keyword: string]: unknown;
  }>;
}

/**
 * Turns TypeBox errors into Standard Schema issues.
 *
 * Errors about the presence of properties are reported by TypeBox against
 * the object that holds them — one error for `{ password, email }` both
 * missing, at the path of the parent. They are split here into one issue
 * per property, at the path of the property itself: `body.password` is
 * where a client puts the message, and a form has no field named `body`
 * to attach "must have required properties password" to.
 *
 * The property names come from `params`, never from the message text —
 * the wording is TypeBox's to change, the structured fields are the
 * contract.
 */
function collectIssues(
  errors: Iterable<TypeBoxError>,
  schema: unknown,
): StandardIssue[] {
  const issues: StandardIssue[] = [];
  const raw = [...errors];
  const collapsed = choiceFailures(raw, schema);

  for (const error of raw) {
    if (
      belongsToChoice(error, collapsed) ||
      echoesAdditionalProperties(error)
    ) {
      continue;
    }

    const at = toPath(error.instancePath);
    const failing = resolveNode(schema, error.schemaPath);
    const missing = propertyNames(error.params?.requiredProperties);
    const unexpected = propertyNames(error.params?.additionalProperties);

    const push = (name: string, fallback: string): void => {
      const declared = childNode(failing, name);

      issues.push({
        message:
          declaredMessage(declared, error.keyword) ??
          declaredMessage(failing, error.keyword) ??
          fallback,
        path: [...at, name],
      });
    };

    if (error.keyword === "required" && missing?.length) {
      for (const name of missing) {
        push(name, "is required");
      }
    } else if (error.keyword === "additionalProperties" && unexpected?.length) {
      for (const name of unexpected) {
        push(name, "is not a property this schema declares");
      }
    } else {
      issues.push({
        message:
          declaredMessage(failing, error.keyword) ??
          collapsed.get(error.schemaPath) ??
          error.message,
        path: at,
      });
    }
  }

  return issues;
}

/**
 * Finds the schemas that are really a set of allowed values, and writes the
 * one message that describes them.
 *
 * The two ways to declare such a set fail differently, and neither says
 * what is allowed. `Type.Union([Type.Literal("debug"), …])` fails every
 * member and reports each one: four "must be equal to constant" and a
 * "must match a schema in anyOf". `Type.Enum({ … })` fails once, with
 * "must be equal to one of the allowed values". Both become
 * `must be one of "debug", "info", "warn", "error"`.
 *
 * A union collapses only when every member is a literal: a union of
 * objects fails for reasons worth reading, and the branch errors are how a
 * client learns which variant it nearly matched.
 */
function choiceFailures(
  errors: readonly TypeBoxError[],
  schema: unknown,
): Map<string, string> {
  const collapsed = new Map<string, string>();

  for (const error of errors) {
    if (error.keyword !== "anyOf" && error.keyword !== "enum") {
      continue;
    }

    const node = resolveNode(schema, error.schemaPath) as
      | { anyOf?: unknown; enum?: unknown }
      | undefined;

    const allowed =
      error.keyword === "enum"
        ? literalValues(node?.enum)
        : literalValues(node?.anyOf);

    if (allowed) {
      collapsed.set(error.schemaPath, `must be one of ${allowed.join(", ")}`);
    }
  }

  return collapsed;
}

/**
 * The values a node allows, printed — the members of an `enum`, or the
 * constants of a union whose every member is one. Nothing, when the node
 * is neither.
 */
function literalValues(members: unknown): string[] | undefined {
  if (!Array.isArray(members) || members.length === 0) {
    return undefined;
  }

  const values = members.map((member) => {
    if (member === null || typeof member !== "object") {
      return JSON.stringify(member);
    }

    return "const" in member
      ? JSON.stringify((member as { const: unknown }).const)
      : undefined;
  });

  return values.every((value) => value !== undefined)
    ? (values as string[])
    : undefined;
}

/**
 * Whether an error is the `false` of `additionalProperties: false` failing
 * on its own.
 *
 * TypeBox reports an undeclared property twice: once against the property,
 * as the sub-schema `false` rejecting it ("schema is false"), and once
 * against the object, as `additionalProperties` naming it. The second is
 * the one this adapter turns into an issue — it carries the property names
 * and the node a message can be declared on. The first says the same thing
 * in TypeBox's internal vocabulary, so it is dropped.
 *
 * The `boolean` keyword fires only for a sub-schema that is literally
 * `false`, and the parent check keeps a property *named*
 * `additionalProperties` from matching its own pointer.
 */
function echoesAdditionalProperties(error: TypeBoxError): boolean {
  const suffix = "/additionalProperties";

  if (error.keyword !== "boolean" || !error.schemaPath.endsWith(suffix)) {
    return false;
  }

  return !error.schemaPath.slice(0, -suffix.length).endsWith("/properties");
}

/** Whether an error is one of the member failures a choice replaced. */
function belongsToChoice(
  error: TypeBoxError,
  collapsed: ReadonlyMap<string, string>,
): boolean {
  for (const schemaPath of collapsed.keys()) {
    if (error.schemaPath.startsWith(`${schemaPath}/anyOf/`)) {
      return true;
    }
  }

  return false;
}

/**
 * The keyword a schema declares its own messages under.
 *
 * Not part of JSON Schema — TypeBox carries unknown keywords untouched,
 * and `documented()` drops this one so it never reaches the OpenAPI
 * document.
 */
const messageKeyword = "errorMessage";

/**
 * The message a schema node declares for a failing keyword, if any.
 *
 * A string covers every way that node can fail; an object names the
 * keywords it overrides — `{ format: "…", required: "…" }` — and leaves
 * the rest to TypeBox.
 */
function declaredMessage(
  node: unknown,
  keyword: string | undefined,
): string | undefined {
  if (node === null || typeof node !== "object") {
    return undefined;
  }

  const declared = (node as Record<string, unknown>)[messageKeyword];

  if (typeof declared === "string") {
    return declared;
  }

  if (declared === null || typeof declared !== "object" || !keyword) {
    return undefined;
  }

  const message = (declared as Record<string, unknown>)[keyword];

  return typeof message === "string" ? message : undefined;
}

/**
 * Walks `schemaPath` — a JSON pointer into the schema, `#/properties/email`
 * — down to the node that rejected the value.
 *
 * The pointer addresses the schema this adapter was handed, which is why
 * the original is kept: TypeBox reports where a check failed, and the
 * message a developer wrote lives at exactly that node.
 */
function resolveNode(root: unknown, schemaPath: string): unknown {
  if (!schemaPath.startsWith("#")) {
    return undefined;
  }

  let node = root;

  for (const segment of schemaPath.slice(1).split("/")) {
    if (segment === "") {
      continue;
    }

    if (node === null || typeof node !== "object") {
      return undefined;
    }

    node = (node as Record<string, unknown>)[decodeSegment(segment)];
  }

  return node;
}

/**
 * The schema of a named property, where the failure is about the property
 * rather than its value: a missing one is reported against the object, but
 * the message for it belongs on the property that is missing.
 */
function childNode(node: unknown, name: string): unknown {
  if (node === null || typeof node !== "object") {
    return undefined;
  }

  const properties = (node as { properties?: unknown }).properties;

  if (properties === null || typeof properties !== "object") {
    return undefined;
  }

  return (properties as Record<string, unknown>)[name];
}

function propertyNames(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((name) => typeof name === "string")
    ? value
    : undefined;
}

function toPath(instancePath: string): (string | number)[] {
  if (instancePath === "") {
    return [];
  }

  return instancePath
    .slice(1)
    .split("/")
    .map((segment) => {
      const key = decodeSegment(segment);

      return /^\d+$/.test(key) ? Number(key) : key;
    });
}

/** Decodes the two escapes of a JSON pointer segment. */
function decodeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Validates a value against a DTO and returns it, or throws.
 *
 * The same check a route runs, outside a request: an environment read at
 * startup, a config file, a job payload taken off a queue. TypeBox
 * validates synchronously, so unlike the general Standard Schema call this
 * needs no `await` — which is what makes it usable where a module-level
 * constant is being built.
 *
 * The failure is a `ValidationError` carrying the same issues a rejected
 * request would carry, `422` and all: caught at startup it is a list of
 * paths and messages to print, and left uncaught inside a handler it is
 * already the response the pipeline knows how to send.
 *
 * The issue paths are read here rather than through the core's
 * `normalizePath`, which is internal: making it public for one caller
 * would grow the core's surface. The two differ only on a segment wrapped
 * as `{ key }` — this turns a numeric key into a string, the core keeps it
 * a number — and that difference is unreachable, because `tb()` builds its
 * paths from bare strings and numbers (see `toPath`). The branch exists
 * for the type. If `tb()` ever wraps its segments, this is where the two
 * readings would part, and it should follow the core.
 *
 * @example Reading the environment at startup
 * ```ts
 * const Env = tb(Type.Object({ PORT: Type.Integer() }), { convert: true });
 *
 * try {
 *   export const env = parse(Env, Bun.env);
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     for (const issue of error.issues) {
 *       console.error(`${issue.path.join(".")}: ${issue.message}`);
 *     }
 *
 *     process.exit(1);
 *   }
 *
 *   throw error;
 * }
 * ```
 */
export function parse<T extends TSchema>(
  schema: TypeBoxSchema<T>,
  value: unknown,
): StaticDecode<T> {
  const result = schema["~standard"].validate(value) as StandardResult<
    StaticDecode<T>
  >;

  if (result.issues) {
    throw new ValidationError(
      422,
      result.issues.map((issue) => ({
        message: issue.message,
        path: (issue.path ?? []).map((segment) =>
          typeof segment === "object" && segment !== null
            ? String(segment.key)
            : (segment as string | number),
        ),
      })),
    );
  }

  return result.value;
}
