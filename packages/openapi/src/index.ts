/**
 * OpenAPI generation for the framework.
 *
 * Reads a compiled application — `app.entries` and the options it actually
 * runs with — and returns an OpenAPI 3.1 document. Nothing is registered,
 * served or mutated: the document is data, and serving it is a route the
 * application declares like any other.
 *
 * Serving it is a route the application declares — or `docs()`, the
 * controller that declares those routes for you.
 *
 * @example
 * ```ts
 * const { document, warnings } = openapi(app, {
 *   info: { title: "Users API", version: "1.0.0" },
 * });
 * ```
 *
 * @module
 */

import type { App } from "@tetsujs/core";
import { contributionsOf } from "./annotations.ts";
import { schemaComponents } from "./components.ts";
import type { OpenApiDocument, PathItemObject } from "./document.ts";
import { operationIds, operationOf } from "./operation.ts";
import { toTemplate } from "./parameters.ts";

export type {
  DocumentedResponse,
  HookContributions,
  HookDocs,
  SecurityRequirement,
  SecurityScheme,
} from "./annotations.ts";
export { documented, secured } from "./annotations.ts";
export type { DocsOptions } from "./controller.ts";
export { DocsController, docs } from "./controller.ts";
export type {
  ContentMap,
  DocumentInfo,
  DocumentServer,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ResponseObject,
} from "./document.ts";
export type { DocsAssets, DocsPageOptions, DocsUi } from "./page.ts";
export { docsPage } from "./page.ts";

/**
 * What the generator cannot read off the application.
 */
export interface OpenApiOptions {
  /** Title, version and the rest of the document's `info` block. */
  readonly info: OpenApiDocument["info"];

  /** Servers the API is reachable at. */
  readonly servers?: OpenApiDocument["servers"];
}

/**
 * What the generator could not describe faithfully.
 *
 * Each entry names a route and what was missing — almost always a schema
 * from a validator that emits no JSON Schema. Documentation that silently
 * omits a body is worse than documentation that says it does not know, so
 * these are returned rather than swallowed.
 */
export interface GeneratorWarning {
  readonly route: string;
  readonly message: string;
}

/** A generated document together with what could not be described. */
export interface GeneratorResult {
  readonly document: OpenApiDocument;
  readonly warnings: readonly GeneratorWarning[];
}

/**
 * Generates the OpenAPI document of an application.
 *
 * Socket endpoints are skipped: a handshake is a `GET` in the table, but
 * OpenAPI has no way to describe what happens after it, and documenting
 * the upgrade as an ordinary operation would describe a request that
 * clients must not make. AsyncAPI is that format, and a separate document.
 *
 * So are routes marked `docs: { hidden: true }`, and everything they would
 * have contributed with them: a security scheme only a hidden route
 * requires has nothing left to describe.
 *
 * Every route of the table becomes an operation under its path template,
 * with the parameters, body and responses its schemas describe. What the
 * framework itself can answer — a validation failure, an unparsable body,
 * a body over the limit — is filled in from the options the application
 * runs with, so the document states the status actually configured.
 */
export function openapi(app: App, options: OpenApiOptions): GeneratorResult {
  const paths: Record<string, PathItemObject> = {};
  const warnings: GeneratorWarning[] = [];
  const schemes: Record<string, unknown> = {};
  const components = schemaComponents();
  const ids = operationIds();

  // Which route already occupies each slot of the document. Two routes the
  // router keeps apart can still meet here, because a template says less
  // than a path does: `/files/*` and `/files/:wildcard` both become
  // `/files/{wildcard}`, and a literal `/users/{id}` — which Bun matches as
  // the string it is — is spelled the same as `/users/:id`. The second one
  // then replaces the first, and the document quietly loses an endpoint
  // that works. It still loses it; it no longer does so without saying.
  const occupied = new Map<string, string>();

  for (const entry of app.entries) {
    if (entry.ws || entry.def.docs?.hidden) {
      continue;
    }

    const template = toTemplate(entry.path);
    const route = `${entry.method} ${entry.path}`;

    const operation = operationOf(
      entry,
      app.options,
      components,
      ids,
      (message) => {
        warnings.push({ route, message });
      },
    );

    // First definition wins, as it does among the hooks of one route: a
    // name is the identity of a scheme, and the operations that reference
    // it say only the name. A second, different scheme under that name
    // cannot be described without renaming it out from under everything
    // already pointing at it, so it is refused rather than silently
    // swapped in — which used to make every earlier operation describe an
    // authentication its route does not perform.
    for (const requirement of contributionsOf(entry.hooks).security) {
      const defined = schemes[requirement.name];

      if (defined === undefined) {
        schemes[requirement.name] = requirement.scheme;

        continue;
      }

      if (JSON.stringify(defined) !== JSON.stringify(requirement.scheme)) {
        warnings.push({
          route,
          message: `the security scheme "${requirement.name}" is already defined differently; this definition is ignored`,
        });
      }
    }

    const slot = `${entry.method.toLowerCase()} ${template}`;
    const taken = occupied.get(slot);

    if (taken) {
      warnings.push({
        route,
        message: `${template} is already described by ${taken}, whose operation this replaces`,
      });
    }

    occupied.set(slot, route);

    paths[template] = {
      ...paths[template],
      [entry.method.toLowerCase()]: operation,
    };
  }

  return {
    document: {
      openapi: "3.1.0",
      info: options.info,
      ...(options.servers ? { servers: options.servers } : {}),
      paths,
      ...componentsOf(schemes, components.schemas),
    },
    warnings,
  };
}

/**
 * The `components` block, present only when something goes in it: the
 * security schemes the guards registered, and the failure envelopes the
 * operations refer to.
 */
function componentsOf(
  securitySchemes: Record<string, unknown>,
  schemas: Record<string, unknown>,
): { components?: Record<string, unknown> } {
  const components = {
    ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
  };

  return Object.keys(components).length > 0 ? { components } : {};
}
