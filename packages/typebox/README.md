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

Options, details and recipes: **[tetsujs.com/docs/packages/typebox](https://tetsujs.com/docs/packages/typebox/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
