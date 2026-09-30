import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://tetsujs.com",
  integrations: [
    starlight({
      title: "Tetsu",
      disable404Route: true,
      logo: {
        light: "./src/assets/logo/tetsu-logo-light.svg",
        dark: "./src/assets/logo/tetsu-logo-dark.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://tetsujs.com/og.png",
          },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "Tetsu — No magic. Just iron. The HTTP framework for Bun.",
          },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
      ],
      plugins: [
        starlightLlmsTxt({
          details: [
            "Facts that are easy to get wrong:",
            "",
            "- Tetsu runs on Bun only (1.4 or later), with TypeScript 5.7 or later and `strict` on.",
            "- There is no `new Tetsu()`, no `app.get()`, no `app.listen()` and no middleware with `next()`. `createApp({ routes, hooks })` returns plain data, served with `Bun.serve({ ...app })`.",
            "- A route is `route({ method, path, schema, hooks, handler })`. A controller is `controller(name, (deps) => ({ ...routes }))`; the name is the contract OpenAPI operation ids are built from.",
            "- No decorators, no DI container, no plugins: dependencies are function arguments, wired by hand in one place.",
            "- Hooks run in fixed slots, in this order: `beforeParse`, `parse`, `beforeValidation`, `validate`, `beforeHandle`, the handler, `beforeResponse`, `afterResponse`; `onError` maps a failure to a response. A hook is made with `hook.<slot>(fn)` and mounted by slot: `hooks: { beforeParse: [auth] }` on a route, a group or the application.",
            "- A hook adds to `ctx` by returning an object, and refuses by throwing `HttpError` or `httpError(status, code, message)`.",
            "- `ctx` is never annotated. A field exists only when declared: path parameters from the path, `ctx.body` only when the route declares a body, a hook's field only after that hook.",
            "- Validation goes through Standard Schema (Zod, Valibot, ArkType; TypeBox via `@tetsujs/typebox`). A failure is a 422; every error body is `{ status, message, error }`.",
            "- Handlers are unit-tested with `testCtx()` and applications through a real server with `serve()`, both from `@tetsujs/core/testing`.",
            "- Packages, all released together under one version: `@tetsujs/core`, `openapi`, `typebox`, `cors`, `rate-limit`, `request-id`, `request-log`, `secure-headers`, `sse`, `lifecycle`.",
            "",
            "Every documentation page is also served as Markdown: add `.md` to its path, e.g. https://tetsujs.com/docs/concepts/errors.md.",
          ].join("\n"),
          // Type hints, open type boxes and compiler errors are interleaved with the code in
          // the rendered HTML; left in, they would read as part of it.
          customSelectors: {
            all: [
              ".twoslash-popup-container",
              ".twoslash-static",
              ".twoslash-error-box",
              ".sl-anchor-link",
            ],
          },
          projectName: "Tetsu",
          description:
            "Tetsu is an HTTP framework for Bun: named controllers, lifecycle hooks in fixed slots and types inferred from end to end, without decorators, a DI container or dependencies in the core.",
        }),
      ],
      customCss: ["./src/styles/theme.css"],
      components: {
        Footer: "./src/components/Footer.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Hero: "./src/components/Hero.astro",
        PageTitle: "./src/components/PageTitle.astro",
        TwoColumnContent: "./src/components/TwoColumnContent.astro",
      },
      editLink: { baseUrl: "https://github.com/tetsujs/tetsu/edit/main/site/" },
      sidebar: [
        {
          label: "Getting started",
          items: [
            "docs",
            "docs/installation",
            "docs/quick-start",
            "docs/key-concepts",
          ],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "docs/concepts" } }],
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "docs/guides" } }],
        },
        {
          label: "Packages",
          items: [{ autogenerate: { directory: "docs/packages" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "docs/reference" } }],
        },
        {
          label: "More",
          items: [
            "docs/more/faq",
            "docs/more/comparison",
            "docs/more/performance",
            "docs/more/stability",
            {
              label: "Changelog",
              link: "https://github.com/tetsujs/tetsu/releases",
            },
          ],
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tetsujs/tetsu",
        },
      ],
    }),
  ],
});
