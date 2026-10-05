# @tetsujs/sse

Server-sent events and streamed responses for [Tetsu](https://tetsujs.com), from an async
generator.

```bash
bun add @tetsujs/sse
```

```ts
import { sse } from "@tetsujs/sse";

const feed = route({
  method: "GET",
  path: "/prices",
  handler: (ctx) =>
    sse(ctx, async function* (signal) {
      for await (const price of prices.watch({ signal })) {
        yield { data: price, id: price.at };
      }
    }),
});
```

## Documentation

- [tetsujs.com/docs/packages/sse](https://tetsujs.com/docs/packages/sse/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/sse.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
