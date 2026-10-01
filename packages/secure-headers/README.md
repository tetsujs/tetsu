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

Options, details and recipes: **[tetsujs.com/docs/packages/secure-headers](https://tetsujs.com/docs/packages/secure-headers/)**

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
