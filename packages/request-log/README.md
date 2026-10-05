# @tetsujs/request-log

Request logs for [Tetsu](https://tetsujs.com): a line when a request arrives, and a line when
it is done.

```bash
bun add @tetsujs/request-log
```

```ts
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";

const id = requestId();
const finished = accessLog({ write: (record) => logger.info(record, "request finished") });

createApp({
  hooks: { beforeParse: [id], afterResponse: [finished] },
  routes,
});
```

## Documentation

- [tetsujs.com/docs/packages/request-log](https://tetsujs.com/docs/packages/request-log/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/request-log.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
