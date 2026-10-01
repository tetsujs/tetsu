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

Options, details and recipes: **[tetsujs.com/docs/packages/request-log](https://tetsujs.com/docs/packages/request-log/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
