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

## Documentation

- [tetsujs.com/docs/packages/openapi](https://tetsujs.com/docs/packages/openapi/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/openapi.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
