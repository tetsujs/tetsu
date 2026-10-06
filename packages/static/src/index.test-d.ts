/**
 * Type-level tests for the options of `staticFiles()` and the places its
 * handler goes.
 *
 * @module
 */

import type { FallbackHandler } from "@tetsujs/core";
import { createApp, group, route } from "@tetsujs/core";
import type { StaticHandler } from "./index.ts";
import { staticFiles } from "./index.ts";

const root = "./dist";

export const site: StaticHandler = staticFiles({
  root,
  notFound: "404.html",
  precompressed: true,
});

export const singlePage: FallbackHandler = staticFiles({ root, spa: true });

export const onApplication = createApp({
  routes: [],
  fallback: staticFiles({ root }),
});

export const onRoute = route({
  method: "GET",
  path: "/assets/*",
  handler: staticFiles({ root }),
});

export const inGroup = group("/admin", {
  children: [
    route({
      method: "GET",
      path: "/*",
      handler: staticFiles({ root, spa: true, index: "app.html" }),
    }),
  ],
});

const files = staticFiles({ root });

export const wrapped = route({
  method: "GET",
  path: "/downloads/*",
  handler: (ctx) => {
    ctx.out.headers.set("content-disposition", "attachment");

    return files(ctx);
  },
});

export const byPath = staticFiles({
  root,
  cacheControl: (path) => (path.endsWith(".html") ? "no-cache" : "max-age=60"),
});

declare const isApp: boolean;

export const decidedAtStartup = staticFiles({ root, spa: isApp });

export const notASinglePage = staticFiles({
  root,
  spa: false,
  notFound: "404.html",
});

// @ts-expect-error a single-page app has no not-found page: its router shows one
export const both = staticFiles({ root, spa: true, notFound: "404.html" });

// @ts-expect-error spa may be true, and then there is no not-found page
export const maybeBoth = staticFiles({
  root,
  spa: isApp,
  notFound: "404.html",
});

// @ts-expect-error the shell of a single-page app is its index file
export const shellWithoutIndex = staticFiles({ root, spa: true, index: false });

// @ts-expect-error spa is true or false
export const spaAsText = staticFiles({ root, spa: "yes" });

// @ts-expect-error a site needs its root
export const withoutRoot = staticFiles({ spa: true });

export const cacheControlAsNumber = staticFiles({
  root,
  // @ts-expect-error cacheControl's function says the header's value
  cacheControl: (path) => path.length,
});

// @ts-expect-error notFound, misspelled
export const misspelled = staticFiles({ root, notfound: "404.html" });
