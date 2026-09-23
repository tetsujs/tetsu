/**
 * File schemas for form bodies.
 *
 * A route with `bodyType: "form"` receives native `File` values inside
 * `ctx.body`, and they go through the route's `body` schema like every
 * other field. TypeBox has no file type of its own, so these two build it
 * out of what TypeBox does have: a permissive base carrying explicit
 * refinements.
 *
 * The base has to stay permissive. TypeBox compiles JSON Schema keywords
 * faithfully, so a `type: "string"` on the validated schema — the shape
 * OpenAPI wants for a binary payload — would reject every `File` before a
 * refinement ever ran. The documentation shape is therefore carried apart
 * from the validated one and substituted when JSON Schema is emitted.
 *
 * @example
 * ```ts
 * const Avatar = tb(
 *   Type.Object({
 *     title: Type.String(),
 *     avatar: file({ maxSize: "5m", type: "image" }),
 *     gallery: files({ maxSize: "1m" }),
 *   }),
 * );
 * ```
 *
 * @module
 */

import { type TSchema, type TUnsafe, Type } from "typebox";

/**
 * A size in bytes, or with a unit: `"512k"` is 512 KiB, `"5m"` is 5 MiB.
 * The same two suffixes Elysia accepts, for the same reason — a byte count
 * with six digits reads worse than the number it stands for.
 */
export type FileSize = number | `${number}k` | `${number}m`;

/**
 * Constraints on an uploaded file.
 *
 * All of them are checked after the body has been read and parsed, which
 * makes them a contract, not a defence: the request has already been
 * buffered by the time they run. The barrier against oversized uploads is
 * `maxBodySize` on the application, enforced while reading.
 */
export interface FileOptions {
  /** Largest accepted size. */
  readonly maxSize?: FileSize;

  /** Smallest accepted size — rejects the empty file a form sends for an untouched input. */
  readonly minSize?: FileSize;

  /**
   * Accepted MIME types. A bare prefix matches a family: `"image"` accepts
   * `image/png` and `image/webp`, `"image/png"` accepts only that one.
   */
  readonly type?: string | readonly string[];
}

/** The documentation shape of one file, kept off the validated schema. */
interface FileDocs {
  readonly type: "string";
  readonly contentEncoding: "binary";
  readonly contentMediaType?: string;
  readonly maxLength?: number;
  readonly minLength?: number;
}

/** What {@link fileDocs} returns: one file, or an array of them. */
export type FileSchemaDocs =
  | FileDocs
  | { readonly type: "array"; readonly items: FileDocs };

/**
 * The key carrying the documentation shape.
 *
 * Non-enumerable, like TypeBox's own `~refine`: a schema must keep
 * serializing as clean JSON Schema, and this is not part of it. The
 * emitter in `tb()` reads it explicitly and puts {@link FileDocs} in the
 * node's place.
 */
export const fileDocsKey = "~tetsu/file-docs";

/** Reads the documentation shape a file schema carries, if it is one. */
export function fileDocs(schema: object): FileSchemaDocs | undefined {
  return (schema as Record<string, FileSchemaDocs | undefined>)[fileDocsKey];
}

/**
 * A schema for a single uploaded file.
 *
 * @example
 * ```ts
 * const Avatar = tb(Type.Object({ avatar: file({ maxSize: "5m", type: "image" }) }));
 * ```
 */
export function file(options: FileOptions = {}): TUnsafe<File> {
  return describe(refine(options, oneValue), options, false) as TUnsafe<File>;
}

/**
 * A schema for one or more uploaded files, always arriving as an array.
 *
 * A form sends one part per file, so a field that took a single file is a
 * lone `File` and not an array — this normalizes that away, and a handler
 * reading `ctx.body.gallery` always maps over an array.
 *
 * @example
 * ```ts
 * const Gallery = tb(Type.Object({ gallery: files({ maxSize: "1m" }) }));
 * ```
 */
export function files(options: FileOptions = {}): TUnsafe<File[]> {
  const collection = Type.Codec(refine(options, everyMember))
    .Decode((value: unknown): File[] => asArray(value) as File[])
    .Encode((value: File[]): unknown => value);

  return describe(collection as TSchema, options, true) as TUnsafe<File[]>;
}

/**
 * How a check reaches the values it judges: one field holds one file, or
 * an array of them — and a field declared as several may still arrive as a
 * lone file, because a form sends one part per file.
 */
type Fold = (value: unknown, holds: (file: unknown) => boolean) => boolean;

const oneValue: Fold = (value, holds) => holds(value);

const everyMember: Fold = (value, holds) => asArray(value).every(holds);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Builds the checking half: a base that accepts anything, narrowed by
 * explicit refinements.
 *
 * Every constraint is written once and folded over whatever the field
 * holds, so a single file and a list of them fail with the same sentence.
 * A union of the two shapes would report the wrong branch's failure — an
 * oversized file inside an array came back as "expected a file".
 *
 * The result is cast to the file type by the callers. That cast states
 * what the value is, which refinements cannot: they run at request time
 * and leave the static type of the base untouched.
 */
function refine(options: FileOptions, fold: Fold): TSchema {
  let schema = Type.Refine(
    Type.Unsafe<File>({}),
    (value: unknown) => fold(value, (entry) => entry instanceof File),
    () => "expected a file",
  ) as TSchema;

  if (options.maxSize !== undefined) {
    const max = toBytes(options.maxSize);

    schema = Type.Refine(
      schema,
      (value: unknown) =>
        fold(value, (entry) => !(entry instanceof File) || entry.size <= max),
      () => `file must be at most ${max} bytes`,
    ) as TSchema;
  }

  if (options.minSize !== undefined) {
    const min = toBytes(options.minSize);

    schema = Type.Refine(
      schema,
      (value: unknown) =>
        fold(value, (entry) => !(entry instanceof File) || entry.size >= min),
      () => `file must be at least ${min} bytes`,
    ) as TSchema;
  }

  if (options.type !== undefined) {
    const accepted =
      typeof options.type === "string" ? [options.type] : options.type;

    schema = Type.Refine(
      schema,
      (value: unknown) =>
        fold(
          value,
          (entry) =>
            !(entry instanceof File) || matchesType(entry.type, accepted),
        ),
      () => `file type must be ${accepted.join(" or ")}`,
    ) as TSchema;
  }

  return schema;
}

function matchesType(actual: string, accepted: readonly string[]): boolean {
  return accepted.some(
    (candidate) => actual === candidate || actual.startsWith(`${candidate}/`),
  );
}

function describe(
  schema: TSchema,
  options: FileOptions,
  collection: boolean,
): TSchema {
  const one: FileDocs = {
    type: "string",
    contentEncoding: "binary",
    ...(options.type === undefined
      ? {}
      : {
          contentMediaType:
            typeof options.type === "string"
              ? options.type
              : options.type.join(", "),
        }),
    ...(options.maxSize === undefined
      ? {}
      : { maxLength: toBytes(options.maxSize) }),
    ...(options.minSize === undefined
      ? {}
      : { minLength: toBytes(options.minSize) }),
  };

  Object.defineProperty(schema, fileDocsKey, {
    enumerable: false,
    value: collection ? { type: "array", items: one } : one,
  });

  return schema;
}

const units: Record<string, number> = { k: 1024, m: 1024 * 1024 };

function toBytes(size: FileSize): number {
  if (typeof size === "number") {
    return size;
  }

  const unit = units[size.slice(-1)];

  if (unit === undefined) {
    throw new Error(
      `A file size suffix must be "k" or "m", got "${size}" — plain bytes need no suffix`,
    );
  }

  return Number(size.slice(0, -1)) * unit;
}
