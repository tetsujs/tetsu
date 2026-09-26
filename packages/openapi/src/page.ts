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
 * What the CDN serves runs on the application's origin, with its cookies.
 * The default renderers are therefore pinned to an exact version and
 * carry the hash of that file: a CDN, or a package release, that serves
 * something else is refused by the browser rather than run. A page on an
 * origin with a session is still somebody else's application in the
 * user's session — which is why `docs()` can serve the document alone.
 *
 * @module
 */

/** The renderers this package knows how to bootstrap. */
export type DocsUi = "scalar" | "swagger-ui" | "redoc";

/** Where a renderer is loaded from. */
export interface DocsAssets {
  readonly script: string;
  readonly style?: string;

  /**
   * Subresource Integrity hashes of the two files, for a copy that is not
   * on the application's own origin: the browser runs the file only if it
   * hashes to this. Absent, the files are loaded as they are.
   *
   * One line computes one:
   * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`,
   * prefixed with `sha384-`.
   */
  readonly integrity?: {
    readonly script?: string;
    readonly style?: string;
  };
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

/**
 * The renderers by default: an exact version, the file by its full path,
 * and the hash of that file.
 *
 * The full path because a bare package URL is not a file — jsDelivr
 * answers it with a build of its own, whose bytes differ from the file's.
 * Moving to a newer version means a new hash, computed as
 * {@link DocsAssets.integrity} describes.
 */
const defaults: Record<DocsUi, DocsAssets> = {
  scalar: {
    script:
      "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js",
    integrity: {
      script:
        "sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK",
    },
  },
  "swagger-ui": {
    script:
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui-bundle.js",
    style: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/swagger-ui.css",
    integrity: {
      script:
        "sha384-YDALVcy8kj8yltLBVi1vBiBAUqdxvus673gM8XKwiy6aDUJFXivF/KCufekjYbVf",
      style:
        "sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW",
    },
  },
  redoc: {
    script:
      "https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js",
    integrity: {
      script:
        "sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5",
    },
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
      ? `<link rel="stylesheet" href="${escapeHtml(assets.style)}"${verified(assets.integrity?.style)} />`
      : "",
    "</head>",
    "<body>",
    body(options.ui, url),
    `<script src="${escapeHtml(assets.script)}"${verified(assets.integrity?.script)}></script>`,
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
 * The attributes that make the browser check a file against its hash.
 *
 * `crossorigin` comes with it: a file from another origin is checked only
 * when fetched with CORS, and without the attribute the browser refuses
 * it outright rather than skip the check.
 */
function verified(integrity: string | undefined): string {
  return integrity
    ? ` integrity="${escapeHtml(integrity)}" crossorigin="anonymous"`
    : "";
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
