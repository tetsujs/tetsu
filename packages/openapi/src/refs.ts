/**
 * Finding the references in a document that lead nowhere.
 *
 * A validator's JSON Schema is embedded in the document as it is, and the
 * references inside it were written for a schema that stood alone. `#` is
 * the root of the schema, `#/$defs/Node` a definition next to it — but
 * embedded, both resolve against the root of the document instead, which
 * is no schema and has no `$defs`. Zod's recursive and named schemas,
 * ArkType's scopes and Valibot's `lazy` all emit such references, and the
 * document they end up in is invalid without anything saying so.
 *
 * Moving the definitions into `components/schemas` and rewriting the
 * references to them would make those schemas describable. Until then the
 * generator says which references broke, which is what it owes a reader:
 * a document that is silently wrong is worse than one that says so.
 *
 * Internal to the package.
 *
 * @module
 */

/**
 * Keywords whose values are data, not schemas: a `$ref` inside an example
 * or a `const` is a string someone meant to send, not a reference.
 */
const data = new Set(["const", "default", "enum", "example", "examples"]);

/**
 * The local references under `node` that resolve to nothing, each once, in
 * the order they are met.
 *
 * A reference resolves against the closest enclosing schema with an `$id`,
 * as JSON Schema has it — the document, when there is none. A reference
 * that is not local, such as TypeBox's `Node` under `$id: "Node"`, and one
 * to an anchor rather than a pointer are left alone: neither is what the
 * libraries this is about emit, and resolving them takes more than a walk.
 *
 * The walk keeps its own stack and visits each object once per base: a
 * schema may be deeper than the call stack, or contain itself, and neither
 * is a reason for the document not to be generated.
 */
export function unresolvedRefs(node: unknown, document: object): string[] {
  const unresolved = new Set<string>();
  const visited = new Map<object, Set<object>>();
  const pending: [value: unknown, base: object][] = [[node, document]];

  for (let next = pending.pop(); next; next = pending.pop()) {
    const [value, base] = next;

    if (typeof value !== "object" || value === null) {
      continue;
    }

    const bases = visited.get(value) ?? new Set<object>();

    if (bases.has(base)) {
      continue;
    }

    visited.set(value, bases.add(base));

    const schema = value as Record<string, unknown>;
    const resource =
      !Array.isArray(value) && typeof schema["$id"] === "string"
        ? schema
        : base;
    const ref = Array.isArray(value) ? undefined : schema["$ref"];

    if (
      typeof ref === "string" &&
      ref.startsWith("#") &&
      !resolves(ref.slice(1), resource, document)
    ) {
      unresolved.add(ref);
    }

    const children = Object.entries(schema).filter(
      ([keyword]) => Array.isArray(value) || !data.has(keyword),
    );

    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push([children[index]?.[1], resource]);
    }
  }

  return [...unresolved];
}

/**
 * Whether a fragment names a schema within `base`.
 *
 * The empty fragment is `base` itself — a schema when it is a resource,
 * and nothing a schema can refer to when it is the document. A pointer is
 * followed token by token, decoded as a URI fragment and then as JSON
 * Pointer; anything else is an anchor, and is taken on trust.
 */
function resolves(fragment: string, base: object, document: object): boolean {
  if (fragment === "") {
    return base !== document;
  }

  if (!fragment.startsWith("/")) {
    return true;
  }

  let target: unknown = base;

  for (const token of fragment.slice(1).split("/")) {
    if (typeof target !== "object" || target === null) {
      return false;
    }

    const key = decoded(token);

    if (key === undefined || !Object.hasOwn(target, key)) {
      return false;
    }

    target = (target as Record<string, unknown>)[key];
  }

  return (
    (typeof target === "object" && target !== null) ||
    typeof target === "boolean"
  );
}

function decoded(token: string): string | undefined {
  try {
    return decodeURIComponent(token)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
  } catch {
    return undefined;
  }
}
