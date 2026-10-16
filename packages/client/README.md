# @tetsujs/client

A typed fetch client for [Tetsu](https://tetsujs.com) applications.

```bash
bun add @tetsujs/client
```

```ts
import { createClient } from "@tetsujs/client";

const api = createClient({ baseUrl: "https://api.example.com" });

const res = await api.get("/users/:id", { params: { id: 42 } });

if (res.ok) {
  res.data;
}
```

## Documentation

- [tetsujs.com/docs/packages/client](https://tetsujs.com/docs/packages/client/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/client.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
