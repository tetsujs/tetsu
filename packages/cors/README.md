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

## Documentation

- [tetsujs.com/docs/packages/cors](https://tetsujs.com/docs/packages/cors/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/cors.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
