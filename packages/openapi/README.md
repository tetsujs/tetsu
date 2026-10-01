# @tetsujs/openapi

An OpenAPI 3.1 document and docs page generated from [Tetsu](https://tetsujs.com) routes.

```bash
bun add @tetsujs/openapi
```

```ts
import { docs } from "@tetsujs/openapi";

createApp({
  routes: [
    group("/api", { children: [usersController()] }),
    docs({ info: { title: "Users API", version: "1.0.0" } }),
  ],
});
```

Options, details and recipes: **[tetsujs.com/docs/packages/openapi](https://tetsujs.com/docs/packages/openapi/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
