# @tetsujs/cors

CORS headers and preflight responses for [Tetsu](https://tetsujs.com).

```bash
bun add @tetsujs/cors
```

```ts
import { cors } from "@tetsujs/cors";

const browser = cors({ origin: "https://app.example.com" });

createApp({ hooks: { beforeParse: [browser] }, routes });
```

Mount it on the application, not on a group: group hooks do not run for
`404`s and preflights.

Options, details and recipes: **[tetsujs.com/docs/packages/cors](https://tetsujs.com/docs/packages/cors/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
