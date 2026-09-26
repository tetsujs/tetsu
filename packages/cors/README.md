# @tetsujs/cors

CORS headers and preflight responses.

```bash
bun add @tetsujs/cors
```

## Usage

```ts
import { cors } from "@tetsujs/cors";

const browser = cors({ origin: "https://app.example.com" });

createApp({ hooks: { beforeParse: [browser, auth, limit] }, routes });
```

`cors()` is one `beforeParse` hook. It answers a preflight itself, and on
every other request puts its headers in `ctx.out`, which the core lays
over whatever response leaves — errors, `404`s and refusals from the hooks
after it included.

Mount it **on the application**, not on a group: group hooks do not run
for `404`, `405` and `OPTIONS` preflights, so CORS on a group would be
missing from exactly the preflight it is for. And mount it **before every
hook that can refuse**: a hook before it that refuses — a rate limit, an
authentication check — answers before the headers are written, and the
browser cannot read that answer. Before those hooks, it also answers a
preflight before they see it, which matters: a preflight carries no
credentials, and an authentication check would refuse it.

A hook that never refuses can go before it, and then covers preflights
too: after `requestId()`, a preflight's answer carries `x-request-id`;
after `arrivalLog()`, it gets an arrival line. After `cors()`, preflights
stay out of both — pick by whether you want them in your logs.

```ts
createApp({ hooks: { beforeParse: [id, arrival, browser, auth, limit] }, routes });
```

## Options

| Option | Default | |
| --- | --- | --- |
| `origin` | — | `"*"`, one origin, or a list of origins matched exactly |
| `methods` | `GET, POST, PUT, PATCH, DELETE` | methods allowed in a preflight |
| `headers` | `content-type, authorization` | request headers a browser may send |
| `exposeHeaders` | none | response headers a browser may read |
| `credentials` | `false` | allow cookies and credentials; refused together with `origin: "*"`, which browsers reject |
| `maxAge` | `86400` | how long a browser may cache a preflight, in seconds |
