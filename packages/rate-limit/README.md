# @tetsujs/rate-limit

Fixed-window rate limiting for [Tetsu](https://tetsujs.com), with a replaceable store.

```bash
bun add @tetsujs/rate-limit
```

```ts
import { rateLimit } from "@tetsujs/rate-limit";

const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

createApp({ hooks: { beforeParse: [limit] }, routes });
```

## Documentation

- [tetsujs.com/docs/packages/rate-limit](https://tetsujs.com/docs/packages/rate-limit/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/rate-limit.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
