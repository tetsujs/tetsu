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

Options, details and recipes: **[tetsujs.com/docs/packages/sse](https://tetsujs.com/docs/packages/sse/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
