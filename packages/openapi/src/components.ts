/**
 * The document's `components/schemas` section.
 *
 * The failures the framework fills in repeat across every operation — a
 * `500` on all of them, a `413` on every route with a body — and inlining
 * the same envelope each time makes a document that is mostly boilerplate.
 * They are defined once here and referenced with `$ref`, which is also how
 * a client generator ends up with one `MalformedJson` type instead of one
 * per endpoint.
 *
 * Only the framework's own shapes go here. A schema that came from a
 * validator is still inlined: it is the author's, it has no name the
 * generator could give it, and `$ref` would invent one.
 *
 * @module
 */

/** A reference to a definition in `components/schemas`. */
export interface SchemaRef {
  readonly $ref: string;
}

/** The definitions collected while generating a document. */
export interface SchemaComponents {
  /**
   * Registers a schema and returns the reference to it.
   *
   * Identical schemas share one definition, whatever name each caller
   * asked for; different schemas that want the same name get a numbered
   * one, so a document is never silently wrong about what a `$ref` points
   * at.
   */
  ref(preferred: string, schema: Record<string, unknown>): SchemaRef;

  /** What was registered, in registration order. */
  readonly schemas: Record<string, unknown>;
}

export function schemaComponents(): SchemaComponents {
  const schemas: Record<string, unknown> = {};
  const registered = new Map<string, string>();

  return {
    schemas,

    ref(preferred: string, schema: Record<string, unknown>): SchemaRef {
      const fingerprint = JSON.stringify(schema);
      const already = registered.get(fingerprint);

      if (already) {
        return { $ref: `#/components/schemas/${already}` };
      }

      let name = preferred;

      for (let attempt = 2; name in schemas; attempt += 1) {
        name = `${preferred}${attempt}`;
      }

      schemas[name] = schema;
      registered.set(fingerprint, name);

      return { $ref: `#/components/schemas/${name}` };
    },
  };
}

/**
 * The name a failure is defined under: its `error` code in PascalCase —
 * `MALFORMED_JSON` becomes `MalformedJson` — so the definition and the code
 * a client branches on read as the same thing.
 *
 * A failure whose code only the hook knows, and which the hook did not
 * declare, is named after its status instead.
 */
export function failureName(status: number, error?: string): string {
  const name = (error ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  // A code with nothing ASCII in it sanitizes to nothing — a code in
  // Cyrillic or Japanese, or one that is all punctuation. That is the same
  // situation as no code at all, and gets the same name: the alternative
  // was a component keyed `""`, which the specification does not allow, and
  // a second such code keyed `"2"` by the collision numbering below it.
  return name || `Failure${status}`;
}
