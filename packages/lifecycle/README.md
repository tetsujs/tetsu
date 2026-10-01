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

Options, details and recipes: **[tetsujs.com/docs/packages/lifecycle](https://tetsujs.com/docs/packages/lifecycle/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
