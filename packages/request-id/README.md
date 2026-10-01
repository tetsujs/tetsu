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

Options, details and recipes: **[tetsujs.com/docs/packages/request-id](https://tetsujs.com/docs/packages/request-id/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
