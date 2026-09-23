/**
 * Path templates and request parameters.
 *
 * The framework's path syntax is Bun's — `:param` and a trailing `*` —
 * while OpenAPI templates variables as `{param}`. The conversion happens
 * here, together with the parameter objects the template then requires:
 * OpenAPI demands that every variable in a path be declared.
 *
 * @module
 */

import type { AnySchema } from "@tetsujs/core";
import type { ParameterObject } from "./document.ts";
import { emitted } from "./emit.ts";

/** The name a wildcard segment is documented under. */
export const wildcardName = "wildcard";

/**
 * Rewrites a route path as an OpenAPI path template.
 *
 * A wildcard becomes an ordinary variable: OpenAPI has no syntax for
 * "everything below here", so the closest honest template is a named
 * segment, documented as such.
 */
export function toTemplate(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        return `{${segment.slice(1)}}`;
      }

      return segment === "*" ? `{${wildcardName}}` : segment;
    })
    .join("/");
}

/** The variables a path template declares, in order. */
export function templateNames(path: string): string[] {
  const names: string[] = [];

  for (const segment of path.split("/")) {
    if (segment.startsWith(":")) {
      names.push(segment.slice(1));
    } else if (segment === "*") {
      names.push(wildcardName);
    }
  }

  return names;
}

/**
 * Describes the path parameters of a route.
 *
 * A `params` schema describes the whole object, so each variable takes the
 * property of the same name; without one — or without a property for a
 * given variable — the value is what the router captured: a string.
 */
export function pathParameters(
  path: string,
  schema: AnySchema | undefined,
  warn: (message: string) => void,
): ParameterObject[] {
  const properties = objectProperties(schema, "params", warn);

  return templateNames(path).map((name) => ({
    name,
    in: "path" as const,
    required: true,
    ...(name === wildcardName
      ? {
          description:
            "Matches the rest of the path, including further segments.",
        }
      : {}),
    schema: properties[name] ?? { type: "string" },
  }));
}

/**
 * Describes the query, header or cookie parameters of a route.
 *
 * All three are objects at the schema level and lists of parameters in a
 * document, so each declared property becomes one parameter, required when
 * the schema says so.
 *
 * A session cookie is the exception the specification makes itself: a
 * credential belongs in `securitySchemes` as `apiKey in: cookie`, not
 * among the parameters. Nothing here can tell one cookie from the other —
 * that is what an annotation on the hook reading it is for, the same way
 * `secured()` marks an authenticating hook.
 */
export function partParameters(
  schema: AnySchema | undefined,
  where: "query" | "header" | "cookie",
  warn: (message: string) => void,
): ParameterObject[] {
  if (!schema) {
    return [];
  }

  const described = emitted(schema, `the ${where}`, warn, "input");

  if (!described) {
    return [];
  }

  const properties = (described.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(described.required) ? (described.required as string[]) : [],
  );

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: where,
    required: required.has(name),
    schema: property,
  }));
}

function objectProperties(
  schema: AnySchema | undefined,
  where: string,
  warn: (message: string) => void,
): Record<string, Record<string, unknown>> {
  if (!schema) {
    return {};
  }

  const described = emitted(schema, `the ${where}`, warn, "input");

  if (!described) {
    return {};
  }

  return (described.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
}
