/**
 * The documentation endpoints as a mountable controller.
 *
 * `openapi()` returns data and mounts nothing, which is the right default
 * for a generator but a chore in the ordinary case: every application ends
 * up writing the same controller, holding the same application, to serve
 * the same two routes. {@link docs} is that controller, written once.
 *
 * It is a controller like any other — mounted in `routes`, groupable,
 * hookable — that receives the application through `onMount` and generates
 * the document from it at startup.
 *
 * @module
 */

import type { App, RouteDef, SchemaConfig, ValidatePath } from "@tetsujs/core";
import { onMount, route } from "@tetsujs/core";
import type { OpenApiDocument } from "./document.ts";
import type { GeneratorWarning } from "./index.ts";
import { openapi } from "./index.ts";
import type { DocsAssets, DocsUi } from "./page.ts";
import { docsPage } from "./page.ts";

/** What the documentation controller serves, and from where. */
export interface DocsOptions<Path extends string, UiPath extends string> {
  /** Title, version and the rest of the document's `info` block. */
  readonly info: OpenApiDocument["info"];

  /** Servers the API is reachable at. */
  readonly servers?: OpenApiDocument["servers"];

  /** Where the document is served. Defaults to `/openapi.json`. */
  readonly path?: Path & ValidatePath<Path>;

  /** Where the page is served. Defaults to `/docs`. */
  readonly uiPath?: UiPath & ValidatePath<UiPath>;

  /** Which renderer the page bootstraps. Defaults to `"scalar"`. */
  readonly ui?: DocsUi;

  /** Browser title of the page. Defaults to the document's own title. */
  readonly title?: string;

  /** Overrides the renderer's CDN URLs, for a pinned or self-hosted copy. */
  readonly assets?: DocsAssets;

  /**
   * Documents the two endpoints this controller serves.
   *
   * Off by default: a reader who is looking at the document has already
   * found the document, and an operation for "the page you are reading"
   * is one a generated client would happily produce a method for.
   */
  readonly documentSelf?: boolean;

  /**
   * What to do with what the generator could not describe.
   *
   * Defaults to one `console.warn` per warning, at startup — a document
   * that silently omits a body is worse than a noisy one.
   */
  readonly onWarning?: (warning: GeneratorWarning) => void;
}

/**
 * The controller {@link docs} returns: two routes and the `onMount` that
 * fills them.
 *
 * Instantiated through the factory, never directly — the routes carry the
 * configured paths in their types, which only the factory can infer.
 */
export class DocsController<Path extends string, UiPath extends string> {
  /** The document itself, as `application/json`. */
  readonly json: RouteDef<Path, SchemaConfig, never, undefined, "GET">;

  /** The page that renders it. */
  readonly ui: RouteDef<UiPath, SchemaConfig, never, undefined, "GET">;

  private document: OpenApiDocument | undefined;

  constructor(
    private readonly options: DocsOptions<Path, UiPath>,
    documentPath: string,
    uiPath: string,
    page: string,
  ) {
    const hidden = !options.documentSelf;

    const json = route({
      method: "GET",
      path: "/openapi.json",
      docs: { summary: "This document", tags: ["docs"], hidden },
      handler: () => this.document,
    });

    const ui = route({
      method: "GET",
      path: "/docs",
      docs: { summary: "Rendered documentation", tags: ["docs"], hidden },
      handler: () =>
        new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    /**
     * The configured paths, put back on the routes.
     *
     * `route()` validates its path at the type level, and that check
     * cannot be satisfied by a type variable — `ValidatePath<Path>` stays
     * unresolved while `Path` is generic. The routes are therefore built
     * with the default literals and re-typed here, which is also where the
     * configured path lands at runtime.
     */
    this.json = { ...json, path: documentPath } as unknown as this["json"];
    this.ui = { ...ui, path: uiPath } as unknown as this["ui"];
  }

  /** Generates the document of the application this was mounted in. */
  [onMount](app: App): void {
    const generated = openapi(app, {
      info: this.options.info,
      ...(this.options.servers ? { servers: this.options.servers } : {}),
    });

    this.document = generated.document;

    const report = this.options.onWarning ?? warn;

    for (const warning of generated.warnings) {
      report(warning);
    }
  }
}

/**
 * The documentation of an application, as a controller to mount.
 *
 * @example
 * ```ts
 * createApp({
 *   routes: [
 *     group("/api", { children: [new UsersController(users)] }),
 *     docs({ info: { title: "Users API", version: "1.0.0" } }),
 *   ],
 * });
 * ```
 *
 * The document is generated once, at startup, from the application the
 * controller was mounted in. Its own two routes stay out of it — pass
 * `documentSelf` to put them in.
 *
 * The page loads its renderer from a CDN; see {@link docsPage} for the
 * trade and for how to point it at a self-hosted copy.
 */
export function docs<
  const Path extends string = "/openapi.json",
  const UiPath extends string = "/docs",
>(options: DocsOptions<Path, UiPath>): DocsController<Path, UiPath> {
  const documentPath = options.path ?? "/openapi.json";
  const uiPath = options.uiPath ?? "/docs";

  const page = docsPage({
    ui: options.ui ?? "scalar",
    documentUrl: documentPath,
    title: options.title ?? options.info.title,
    ...(options.assets ? { assets: options.assets } : {}),
  });

  return new DocsController(options, documentPath, uiPath, page);
}

function warn(warning: GeneratorWarning): void {
  console.warn(`[openapi] ${warning.route}: ${warning.message}`);
}
