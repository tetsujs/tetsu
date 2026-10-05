# @tetsujs/request-id

Request ids for [Tetsu](https://tetsujs.com).

```bash
bun add @tetsujs/request-id
```

```ts
import { requestId } from "@tetsujs/request-id";

const id = requestId();

createApp({ hooks: { beforeParse: [id] }, routes });
```

## Documentation

- [tetsujs.com/docs/packages/request-id](https://tetsujs.com/docs/packages/request-id/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/request-id.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
