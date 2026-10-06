# @tetsujs/static

Static files for [Tetsu](https://tetsujs.com): a built site, a single-page app or assets, with caching headers and precompressed copies.

```bash
bun add @tetsujs/static
```

```ts
import { staticFiles } from "@tetsujs/static";

createApp({
  routes,
  fallback: staticFiles({ root: "./dist", notFound: "404.html" }),
});
```

## Documentation

- [tetsujs.com/docs/packages/static](https://tetsujs.com/docs/packages/static/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/static.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
