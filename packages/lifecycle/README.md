# @tetsujs/lifecycle

Graceful shutdown for [Tetsu](https://tetsujs.com): drain requests, then close what the server
used.

```bash
bun add @tetsujs/lifecycle
```

```ts
import { onShutdownSignals } from "@tetsujs/lifecycle";

const server = Bun.serve({ ...app });

onShutdownSignals(server, { close: [() => pool.end()] });
```

## Documentation

- [tetsujs.com/docs/packages/lifecycle](https://tetsujs.com/docs/packages/lifecycle/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/lifecycle.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
