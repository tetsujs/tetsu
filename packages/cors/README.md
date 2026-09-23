# @tetsujs/cors

CORS headers and preflight responses.

```bash
bun add @tetsujs/cors
```

## Usage

```ts
import { cors } from "@tetsujs/cors";

createApp({ hooks: [cors({ origin: "https://app.example.com" })], routes });
```

Mount it on the application, not on a group. Group hooks do not run for
`404`, `405` and `OPTIONS` preflights, so CORS on a group would be missing
from exactly the preflight it is for.

The headers go on every response the application sends — errors,
refusals from other hooks and `404`s included.

## Options

| Option | Default | |
| --- | --- | --- |
| `origin` | — | `"*"`, one origin, or a list of origins matched exactly |
| `methods` | `GET, POST, PUT, PATCH, DELETE` | methods allowed in a preflight |
| `headers` | `content-type, authorization` | request headers a browser may send |
| `exposeHeaders` | none | response headers a browser may read |
| `credentials` | `false` | allow cookies and credentials; refused together with `origin: "*"`, which browsers reject |
| `maxAge` | `86400` | how long a browser may cache a preflight, in seconds |
