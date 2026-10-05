# @tetsujs/typebox

TypeBox schemas as [Tetsu](https://tetsujs.com) DTOs: compiled validation, type inference and
OpenAPI.

```bash
bun add @tetsujs/typebox
```

```ts
import { tb, Type } from "@tetsujs/typebox";

const CreateUser = tb(
  Type.Object({
    name: Type.String({ minLength: 1 }),
    email: Type.String({ format: "email" }),
  }),
);

route({
  method: "POST",
  path: "/users",
  schema: { body: CreateUser },
  handler: (ctx) => users.create(ctx.body),
});
```

## Documentation

- [tetsujs.com/docs/packages/typebox](https://tetsujs.com/docs/packages/typebox/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/typebox.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
