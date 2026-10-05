# @tetsujs/secure-headers

Security headers for every [Tetsu](https://tetsujs.com) response: HSTS, CSP, frame and referrer
policies.

```bash
bun add @tetsujs/secure-headers
```

```ts
import { secureHeaders } from "@tetsujs/secure-headers";

const secure = secureHeaders();

createApp({ hooks: { beforeResponse: [secure] }, routes });
```

## Documentation

- [tetsujs.com/docs/packages/secure-headers](https://tetsujs.com/docs/packages/secure-headers/): options, details
  and recipes, also [as Markdown](https://tetsujs.com/docs/packages/secure-headers.md)
- [llms-full.txt](https://tetsujs.com/llms-full.txt): the whole documentation in one
  file, for tools and AI assistants
- every export and option is also documented in the package's type
  definitions, which editors and tools read from `node_modules`

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
