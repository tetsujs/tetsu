/**
 * The HTML page that renders a document.
 *
 * Returns a string and mounts nothing: which path serves the page, and
 * whether one is served at all, is the application's decision like every
 * other route.
 *
 * The renderers themselves are loaded from a CDN. Vendoring Scalar or
 * Swagger UI would put megabytes of somebody else's bundle into a
 * dependency-free repository, so the trade is stated instead of hidden:
 * the documentation page — and only it — needs the network, and the URL is
 * a parameter, so a self-hosted copy is one option away. Nothing is
 * fetched unless this function is called.
 *
 * @module
 */

/** The renderers this package knows how to bootstrap. */
export type DocsUi = "scalar" | "swagger-ui" | "redoc";

/** Where a renderer is loaded from. */
export interface DocsAssets {
  readonly script: string;
  readonly style?: string;
}

/** What the page needs to know. */
export interface DocsPageOptions {
  /** Which renderer to bootstrap. */
  readonly ui: DocsUi;

  /** Where the document is served — the page fetches it from there. */
  readonly documentUrl: string;

  /** Browser title; defaults to `"API documentation"`. */
  readonly title?: string;

  /** Overrides the CDN URLs, for a pinned version or a self-hosted copy. */
  readonly assets?: DocsAssets;
}

const defaults: Record<DocsUi, DocsAssets> = {
  scalar: {
    script: "https://cdn.jsdelivr.net/npm/@scalar/api-reference",
  },
  "swagger-ui": {
    script:
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js",
    style: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css",
  },
  redoc: {
    script: "https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js",
  },
};

/**
 * Builds the documentation page.
 *
 * Called by `docs()` for the page it serves; call it directly to serve one
 * from somewhere else.
 *
 * @example
 * ```ts
 * const page = docsPage({ ui: "scalar", documentUrl: "/openapi.json" });
 *
 * const ui = route({
 *   method: "GET",
 *   path: "/docs",
 *   handler: () =>
 *     new Response(page, { headers: { "content-type": "text/html" } }),
 * });
 * ```
 */
export function docsPage(options: DocsPageOptions): string {
  const assets = options.assets ?? defaults[options.ui];
  const title = escapeHtml(options.title ?? "API documentation");
  const url = escapeHtml(options.documentUrl);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    assets.style
      ? `<link rel="stylesheet" href="${escapeHtml(assets.style)}" />`
      : "",
    "</head>",
    "<body>",
    body(options.ui, url),
    `<script src="${escapeHtml(assets.script)}"></script>`,
    bootstrap(options.ui, url),
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

function body(ui: DocsUi, url: string): string {
  if (ui === "scalar") {
    return `<script id="api-reference" data-url="${url}"></script>`;
  }

  if (ui === "redoc") {
    return `<redoc spec-url="${url}"></redoc>`;
  }

  return '<div id="swagger-ui"></div>';
}

function bootstrap(ui: DocsUi, url: string): string {
  if (ui !== "swagger-ui") {
    return "";
  }

  return [
    "<script>",
    `SwaggerUIBundle({ url: "${url}", dom_id: "#swagger-ui" });`,
    "</script>",
  ].join("\n");
}

/**
 * Escapes the values that reach the markup.
 *
 * The document URL and the title come from the application, but they are
 * still values interpolated into HTML — a quote in either would break out
 * of the attribute it sits in.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
