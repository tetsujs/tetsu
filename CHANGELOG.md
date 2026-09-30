# Changelog

All packages share one version. Until `1.0`, a minor version may change the
API.

## 0.6.0 — 2026-09-30

### Breaking changes

- `@tetsujs/core`: in a route's `beforeResponse`, `afterResponse` and
  `onError` hooks, a part a schema owns — `body`, `query`, `headers`,
  `cookies` — is typed as whatever the request got to: the schema's
  output, what the client sent when validation refused it, or what a hook
  before the handler put there. A JSON body there is `unknown`. It was
  typed as validated. `params` and a body parsed without a schema follow
  the same rule, a hook's value included.
- `@tetsujs/core`: in an `afterResponse` hook `ctx.res` is a
  `SentResponse` — what the response says, its status and headers, without
  its body or `clone()`. An observer starts before Bun sends the response,
  and one reading the body broke it: a JSON body became a `500` from Bun,
  a streamed one reached the client empty. Reading it is now a compile
  error.
- `@tetsujs/rate-limit`: a limiter given a `store` needs a `name`, and
  only such a limiter takes one. The store finds a counter by its key, and
  the key was the client alone: two limiters on one store counted into one
  counter, so a login allowed five an hour lived in the window of a global
  limit allowed a hundred a minute. The key is now the name, then the
  client. One name on one store with other settings is refused when the
  second limiter is made.
- `@tetsujs/typebox`: a DTO nested in another with an option the outer
  one does not have — `convert`, `clean`, `defaults` — is refused where the
  outer one is made. A schema is checked with the options of the `tb()`
  around it, so a `PublicUser` declared with `clean: true` and listed in a
  page of users used to lose its `clean` without a word, and the fields it
  was declared to strip went out in the response. A schema derived from a
  DTO — `Type.Pick`, `Type.Omit`, `Type.Partial` — is a new schema and
  carries none of its options.
- `@tetsujs/core`: the `afterResponse` observers of a request start in
  order, each without waiting for the one before. An observer started only
  once an async one before it had settled started after the response was
  sent, and found the URL, the headers and the address gone — `accessLog()`
  behind an async observer wrote nothing, and reported an `Invalid URL` on
  every request. An observer that counted on the one before it having
  finished takes its result in the same hook, or awaits a promise the
  other left.
- `@tetsujs/cors`: an origin a browser would never send — a trailing
  slash, capitals, a path, a default port — is refused where it is
  written, naming the origin it means, and so is a pattern such as
  `https://*.example.com`. Neither ever matched, and every request from
  the site was refused with nothing at startup to say why. An app or
  extension scheme — `capacitor://localhost` — is taken as written.
  So is `"null"` together with `credentials`, which let any site make
  credentialed requests: a sandboxed frame sends it.
- `@tetsujs/core`: a value the handler returns under a status its map
  declares without a body — `null`, or an entry without `body` — is
  refused with a `500` when responses are validated. It was sent past
  every schema: in a map with `200: User`, a `user` returned under `303`
  went out whole, the fields `User` strips included. The compiler catches
  it only when no status of the map has a body.

### Added

- `@tetsujs/core`: a status of a response map can declare the headers and
  cookies it leaves with — `201: { body: Order, headers: Created }`,
  `204: { cookies: SignedIn }` — the way a request declares its parts.
  They are checked with the body when responses are validated, a response
  that breaks them refused with a `500`, and `@tetsujs/openapi` documents
  them: each header its schema names, required as it says, and the cookies
  as the `set-cookie` header that sets them.
- `@tetsujs/openapi/testing`: `assertDescribed` reports a header the
  status requires and the response does not carry.
- `@tetsujs/rate-limit`: `perRoute: true` gives each route a budget of its
  own from one limiter — twenty a minute on every endpoint, mounted once
  on the application. A route is its template; requests no route answers
  share one budget.
- `@tetsujs/lifecycle`: `onShutdownSignals` returns `draining` too, a
  signal that fires when the server starts to stop — after the pre-stop
  delay. `@tetsujs/sse`: `sse()` and `stream()` take `until`, a signal that
  ends the stream. Together they close the streams a stopping server would
  otherwise wait for: `server.stop()` waits for every response in flight,
  and an event stream held every deploy for the whole grace period before
  it was cut and the process exited with `1`.
- `@tetsujs/request-log`: an access record carries `aborted: true` when
  the connection closed before the response was ready — the client left,
  or a forced stop cut it — with the status the server answered. It read
  as an ordinary success.
- `@tetsujs/core`: `signedCookie(ctx, name)` reads a signed cookie with its
  seal checked, in any hook — before the body is read, where `ctx.cookies`
  is not filled yet. It reads the first value of the name whose seal
  holds, as the core does. A hook that authenticated before the body had
  nothing to check the seal with, and a rate limit keyed by the sealed
  string gave a client a new budget for every junk value put in front of
  the real one.
- `@tetsujs/rate-limit`: `slot` runs a limiter in `beforeValidation` —
  the body parsed, not yet validated — or `beforeHandle` rather than
  `beforeParse`. In `beforeHandle` its key reads the validated body — a
  limit by the account a login names, which holds against guessing a
  password from many addresses — or a user a hook looked up. The compiler
  keeps it in that slot.
- `@tetsujs/core`: `ws()` takes `until` — a signal, or a function asked as
  a socket opens — and closes the endpoint's sockets with `1001` when it
  fires, and a socket opened after it at once. With `draining` from
  `@tetsujs/lifecycle` a deploy no longer waits out the grace period for
  an open socket, cuts it with `1006`, and exits as a forced stop.

### Fixed

- `@tetsujs/openapi`: the Swagger UI page fetches the document from the
  address it was given when that address has a query of more than one
  parameter. The address was escaped for HTML inside a script, where `&`
  stays `&amp;`; Swagger UI now reads it from an attribute, as Scalar and
  Redoc do.
- `@tetsujs/openapi/testing`: `assertDescribed` finds no operation for a
  path longer than every template it could be, where it used to check the
  response against a template ending in a parameter — `/users/1/2/3`
  against `/users/{id}`. Only `{wildcard}`, a trailing `*`, takes the rest
  of a path.
- `@tetsujs/openapi/testing`: `assertDescribed` reports an empty body where
  the status describes one. It passed it, whatever the document said.
- `@tetsujs/openapi`: the README says that a `docs()` documents the whole
  application it is mounted in, and that several surfaces with a document
  each are several applications. It described them as one application with
  several `docs()`, which does not start: two controllers of one
  application cannot share a name.
- `@tetsujs/openapi`: a route that validates only its cookies documents the
  `422` it answers when they fail; a schema on the cookies alone did not
  count as one on a request part.
- `@tetsujs/openapi`: a route with `rawBody: true` and no body schema
  documents the JSON body it parses, and the `400` and `413` it answers when
  that body is not JSON or too large. Only a body schema or a `bodyType`
  counted as a body.
- `@tetsujs/openapi`: a response header or cookie whose schema gives it a
  default is documented as optional. The response carries what the handler
  set, not what the schema returns, so the default is never sent; the
  document read the schema's output, where the field is filled, and called
  it required.
- `@tetsujs/openapi`: the README's recipe for an error format of one's own
  answers an unexpected error in that format too, and reports it with
  `reportFailure`, since `reportError` hears only of what no hook
  answered. Its hook left such errors to the framework, whose `500` the
  document described in the application's format; its contract test, now
  on `assertDescribed`, provokes the `500` as well.
- `@tetsujs/core`: `ctx.route` is not optional in the `beforeResponse`,
  `afterResponse` and `onError` hooks of a route, where it is always set;
  a hook asking for it with `Requires<{ route: RouteInfo }>` mounts there.
- `@tetsujs/core`: a route that parses its body without a schema — a
  `bodyType` or `rawBody` — types `ctx.body` from `beforeValidation` on as
  what parsing produced, or what a `beforeValidation` hook made of it. A
  body a `beforeParse` hook returned stayed in the type, and parsing
  replaced it at runtime.
- `@tetsujs/openapi`: a route whose map declares no `2xx` — only a
  redirect, say — is documented with the statuses it declares. A `200`
  nobody declared was added, and a client generated from the document
  waited for it.
- `@tetsujs/core`: frames of a socket reach `message` in the order they
  arrived when `schema.message` checks asynchronously, and none after the
  socket closed. Each frame waited on its own check, so one checked faster
  overtook one checked slower, and a frame refused at once closed the
  socket under the one before it, which then arrived after `close`.
- `@tetsujs/core`: a `HEAD` request states the `content-length` a `GET`
  would send. The `GET` response was rebuilt without its body, and the
  length Bun computes as it sends came out `0` on every route; now Bun
  answers the `HEAD` from the response itself.
- `@tetsujs/core`: a route at `/` under a group is `"GET /api/users"` in
  `AppRoutes`, the path it is served at. The type joined a trailing slash
  Bun never matches. A route under a symbol key, which the types listed
  and the table never served, is refused at startup.
- `@tetsujs/core`: `group()` refuses `?`, `{` and `}` in a prefix at
  startup, as `route()` does in a path; the compiler refused them only in
  a literal, and a prefix from configuration served every route under it
  as a `404`.
- `@tetsujs/core`: `route()` refuses a method it cannot serve at startup —
  a lower-case `"get"`, which never ran and was advertised in the `405`'s
  `Allow`, or a `HEAD` or `OPTIONS`, which took over what every path
  answers itself.
- The README and `hook.afterResponse` said observers run after the
  response is sent. They start as it goes to Bun: their synchronous part
  is part of the response's latency, and what they need of the request or
  the response they read before their first `await` — after it, a URL, a
  header or the client's address nobody read may be gone, without an
  error. The documentation says so, with a recipe for each, and so do
  `@tetsujs/request-log` and `@tetsujs/sse`.
- `@tetsujs/core`: a `beforeResponse` hook failing over an error response
  is reported once, as `"unhandled"`, and not at all when `onError`
  answers it or it threw an `HttpError` — as the same hook failing over a
  response is. The error path used to report it as `"errorResponse"` and
  then again, and to report an `HttpError` thrown on purpose.
  `"errorResponse"` is now the failure the error path had no attempt left
  to answer — an `HttpError` whose body throws when serialized.
- `@tetsujs/core`: `hook.onError` takes a function that returns a
  `Response` or nothing. One returning an object — `{ status: 409 }`, the
  way another framework maps an error — used to compile, and the runtime,
  which takes only a `Response` from this slot, answered with a `500`.
- `@tetsujs/core`: an empty or missing `cookies.secret` is refused at
  startup. The application used to start and sign with a key anyone can
  compute — an empty one, or none at all when the variable was unset — so
  a forged cookie read as signed.
- `@tetsujs/core`: a signed cookie whose forged signature has a non-ASCII
  character reads as absent, as any bad signature does. It used to fail
  the request with a `500` when the signature was as long as a real one
  in characters but not in bytes.
- `@tetsujs/core`: a cookie name the request carries twice reads as its
  first value in `ctx.cookies`, as `req.cookies.get` reads it — the
  host's own cookie, which a browser sends before one a sibling subdomain
  set for the whole domain. It used to read as the last. Of a signed
  name, the first value whose seal holds.
- `@tetsujs/core`: a schema that refuses a request part with an empty list
  of issues — which Standard Schema allows — fails the request with a
  `422`. The raw value used to reach the handler as if it were valid.
- `@tetsujs/core`: a `json` or `text` body that starts with a byte order
  mark reads without it however it was sent. Sent in chunks, the mark
  used to stay, and a JSON body failed with a `400`.
- `@tetsujs/openapi`: a reference in a validator's schema that leads
  nowhere once the schema is embedded is reported as a warning — the `#`
  of a recursive Zod schema, the `#/$defs/…` of a named one, of an ArkType
  scope, of Valibot's `lazy`. The document used to be invalid without a
  word.
- The guide says that a query or form key sent once arrives as a string,
  and shows the schema taking one value for an array. It did not, and an
  array parameter documented as `?tag=a` was refused with a `422`.
- `@tetsujs/rate-limit`: a `windowMs` that is not a positive, finite
  number, and a `limit` that is not a whole number of 0 or more, are
  refused when the limiter is made. `NaN` — `Number()` of a variable that
  is not set — and `0` used to start a new window on every request, so the
  limiter refused nothing while its headers reported a budget.
- `@tetsujs/rate-limit`: a refusal's `retry-after` is 1 second at least. A
  store that answered with a window already over made it `0`, and a client
  that followed it retried at once.
- `@tetsujs/rate-limit`: the README's recipes limit what they say they
  do. The first example counted by a session cookie, which a client can
  leave out — skipping the limit — or change on every request, for a new
  budget each time; it counts by the client's address now. The allowance
  for internal callers was a header any client can send; it is an address
  on a list now. The Redis store set the expiry only on the first hit, and
  a timeout between its two commands locked the client out for good; it
  sets it on every hit, if there is none.
- `@tetsujs/typebox`: a codec whose `Decode` throws on what the client
  sent fails the value with a `422` carrying the error's message, and
  `parse()` throws a `ValidationError`. It used to answer `500`: any client
  could cause one with a string `BigInt` cannot read.
- `@tetsujs/typebox`: a property named `errorMessage` stays in the JSON
  Schema a DTO emits, and so does that key inside a `default`, `examples`,
  `const`, `enum`, `dependentRequired` or an `x-` extension. The keyword was dropped wherever the name appeared,
  leaving a document that required a property it did not describe.
- `@tetsujs/typebox`: a failure under a record key that looks like a
  number — `"0"` — has the key in its path as a string. It used to be a
  number, like an array index.
- `@tetsujs/sse`: a source that rejects with the signal's `AbortError`
  when the client leaves — as `fetch`, `events.on` and a timer from
  `node:timers/promises` do once handed the signal — ends the stream as
  `"cancelled"`, and nothing is reported. Every ordinary disconnect used to
  reach `reportError` as a failed stream.
- `@tetsujs/sse`: a generator whose `finally` throws while the stream is
  being cancelled is reported with `source: "stream"`. The rejection went
  unhandled, and Bun ended the process with every other connection in it.
- `@tetsujs/sse`: `sse()` opens with a `: open` comment, so the status and
  headers go out at once. Bun sends them with the first chunk of the body,
  and a feed with nothing to say yet kept a browser's `EventSource` in
  "connecting" until the first event or keep-alive — up to 15 seconds, or
  for good with `heartbeatMs: 0`.
- `@tetsujs/lifecycle`: a server whose `stop` throws is a failure in the
  result, forced, and the closers still run. `shutdown()` used to reject
  past its closers, and `onShutdownSignals` crashed on the unhandled
  rejection before they ran.
- `@tetsujs/lifecycle`: the documentation of `exit: false` says that a
  third signal ends the process anyway, as it always did — the way out of
  a shutdown that hangs.
- `@tetsujs/sse`: a stream starts its generator and keep-alive when it is
  first read, `stream()`'s too. A stream made by a handler that then threw
  was sent nowhere, and its timer beat for as long as the process lived.
- `@tetsujs/sse`: an event's `retry` that is not a whole number of
  milliseconds is refused, as a line break in its `id` is. A browser
  ignores any other value without a word, and a `NaN` from a variable that
  is not set went out as the delay the stream believed it had set.
- `@tetsujs/core`: a response's `vary` from the handler and from a hook
  are merged, each token once. The hook's overwrote the handler's: a
  handler's own `Response` with `Vary: Cookie` under `cors()` left with
  `vary: origin` alone, and a shared cache served one user's response to
  another.
- `@tetsujs/cors`: every answer says `vary: origin` unless the origin is
  `"*"`, those without CORS headers too. A cache that stored an answer to
  a request with no `Origin` as the same for everyone handed it to the
  allowed site, and the browser refused it.
- `@tetsujs/core`: a file input nothing was chosen in — sent by a browser
  as a file with no name and no bytes — is left out of a form body, as a
  field that is not there. An optional file was refused for the type of a
  file nobody chose, on every ordinary HTML form. Two inputs of one name
  with one left empty now give one file rather than two, as a key sent
  once gives one value: a schema takes a single value for a list, as the
  guide's "Validation" shows.
- `@tetsujs/typebox`: the documentation of `files()` says it is `undefined`
  under `Type.Optional` when nothing was chosen, as its type does. It said
  the value was always an array.
- `@tetsujs/secure-headers`: the README's exception that allows a frame
  changes `frame-ancestors` in the policy too, which a browser follows
  over `x-frame-options`; with `apiPolicy` the page stayed unframeable.
  The docs page exception compares the path the page is mounted at,
  prefix and all, and no longer only `/docs`.
- The guide's install section says that TypeScript's `moduleResolution`
  is `bundler`, `node16` or `nodenext`. Under the old `node` mode, which
  does not read `exports`, `@tetsujs/core` was not found, with nothing to
  say why.
- `@tetsujs/core`: a signed cookie a hook returned in `cookies` is checked
  as one from the header is, in any slot and on any route: opened, or
  absent when its seal does not hold. It was taken as it came, and an
  unsigned `session: "admin"` from a hook reached the handler as the
  session. `testCtx()` takes the application's cookie options as a second
  argument, so code that signs cookies or reads them with `signedCookie()`
  can be unit-tested.
- The guide shows a set of hooks several places share spread into each
  slot, `as const`, instead of a helper joining `hooks` objects: the order
  is checked as it was, and the slot shows what runs. The `openapi` error
  format example imports what it uses; the `x-forwarded-for` recipe says
  what it relies on; the guide says how to test a limiter, that an
  upload's type is the client's word, how a missing session answers `401`,
  and how a session cookie reaches a frontend on another site.

### Moving from 0.5

An observer that hands `ctx.res` to a function taking a `Response`, or asks
for it with `Requires<{ res: Response }>`, takes a `SentResponse` instead —
exported by `@tetsujs/core` — or passes on what it reads, such as
`ctx.res.status`. One that reads the body clones the response in a
`beforeResponse` hook, where the response is still the application's.

A unit test of a `rawBody` route without a `bodyType` passes a `body` to
`testCtx()`: the route parses JSON, so its handler has one.

A response or error hook that asks for a validated part —
`Requires<{ body?: Order }>` — asks for `unknown` instead, or for the union
it now is, and narrows before it trusts the value: that hook also runs for
the request the schema refused.

A `tb()` DTO nested in another, with an option the outer one lacks, is
refused at startup: turn the option on for the outer DTO, which then
applies it to the nested one too.

An `afterResponse` observer that relied on the one before it having
finished its async part — a value it left in a shared variable — takes
that result in the same hook, or awaits a promise the other left: the
observers of a request no longer wait for each other.

A handler that returns a value under a status its map declares without a
body — `303: null` next to `201: Order` — returns nothing there: with
responses validated, as they are by default, that value is now a `500`.

A test that reads an `sse()` body whole finds `: open` and a blank line
first, and `onEnd` counts them in `bytes`, though not in `events`.

Code that extends `RateLimitOptions` with an `interface` uses a type
alias and an intersection instead: the options are a union now, since
`name` comes with `store` and without it. `RateLimitHook` is the type of
a limiter in `beforeParse`; one made for another slot is
`ReturnType` of its own `rateLimit()` call.

A `rateLimit()` given a `store` is given a `name` too. A shared store's
keys change from the client to the name and the client, so its counters
start from zero after the deploy, and keys the old Redis recipe left
without an expiry are no longer read — they can be deleted.

## 0.5.3 — 2026-09-27

A test client that keeps its headers and cookies from one request to the
next, and recipes in the README for request metrics, health checks and
reporting a failed background job.

### Added

- `@tetsujs/core/testing`: `serve(app).client({ headers })` is a client
  that sends its own headers with every request and keeps a cookie jar: the
  cookies a response sets go back with the next requests where their
  `Path` matches, and a response that deletes or expires one removes it.
  `json` sends a value as JSON, and a header set to `null` is not sent.
  `client.cookies` reads and plants values.

### Fixed

- `@tetsujs/lifecycle`: the readiness example in the README built its route
  after the server, where it could not be mounted.

## 0.5.2 — 2026-09-27

Descriptions for the document's tags, a check that holds a response to
the document in a test, and the raw bytes of a body for a webhook's
signature; a group is eight times cheaper for the type checker.

### Added

- `@tetsujs/openapi`: `tags` in `openapi()` and `docs()` — what each tag
  is, by name, in the order a renderer lists the sections. A tag the routes
  use and `tags` leaves out is listed after them and reported, and so is a
  described tag no operation uses: either is usually one tag spelled two
  ways. `docs()` describes its own tag when its routes are documented.
- `@tetsujs/openapi/testing`: `assertDescribed(document, "POST /session",
  res)` throws unless a response a test provoked is one the document
  describes for the operation — its status declared, its body one of the
  alternatives of that status, the headers asked about documented — and
  lists every problem at once. `validate` checks the body in full with a
  JSON Schema validator of your choice.
- `@tetsujs/core`: `rawBody: true` on a route keeps the bytes of a `json`
  or `text` body as `ctx.rawBody`, next to the body parsed and validated
  from them — for a webhook signed over its bytes. The field is typed only
  on a route that asks, so a hook requiring it with `Requires` cannot be
  mounted where it is missing; a form or a stream with `rawBody` is
  refused. `rawBody` is now the pipeline's own field: a hook that returned
  a field of that name no longer adds it to the context.

### Changed

- `@tetsujs/core`: a `group()` costs the type checker about 130
  instantiations where it cost about 1 090 — an application of 100 groups
  and 200 routes 194 k where it was 288 k, and 83 MB where it was 114. The
  children met the configuration's own `children` as an intersection of
  two array types, and every method of an array was built once per group.
  Its options besides the children are `GroupOptions`.
- `@tetsujs/core`: the package no longer ships the test helpers of this
  repository that `@tetsujs/core/testing` does not export — type
  assertions, a mock schema, a socket client. They were never importable.

## 0.5.1 — 2026-09-27

### Changed

- `@tetsujs/openapi`: a status the route declares is described by the
  `description` of its schema — for any status, a `200` as much as an
  error — where it used to get only its reason phrase, and the schema's
  description reached only its definition in `components`. Several
  descriptions under one status — the route's, a hook's, the framework's —
  are a list, each item led by its code, where they used to be one line
  joined by `; `.

## 0.5.0 — 2026-09-27

Every failure reaches the application's `onError` hooks — a `404`, a
`405` and a rate limit's refusal included — so one hook sets the format of
every error, and `errors` in `@tetsujs/openapi` describes that format in
the document.

### Breaking changes

- `@tetsujs/core`: `404` and `405` reach the application's `onError` hooks
  as an `HttpError`, like every other failure. An `onError` hook that
  answers every error — or logs each one — now sees unmatched paths and
  methods too. An application without `onError` hooks answers them as
  before, with the same response and at the same cost.
- `@tetsujs/rate-limit`: a refusal is a thrown `HttpError` with `retryAfter`
  in its body, and reaches the application's `onError` hooks. It used to
  be a returned `Response` that `onError` never saw.

### Added

- `@tetsujs/openapi`: `errors` in `openapi()` and `docs()` — an error format
  of the application's own, for the document to describe the framework's
  failures, the hooks' refusals and the routes' own envelopes in it.
  `schema` describes one failure from its status, code, message and
  fields; `discriminator` names the top-level field with the code; `code`
  reads the code from a route's schema, for a format that nests it. A
  definition that differs from the kept one is now compared at every
  depth, so a nested format's missing field is reported by its path.

### Changed

- `@tetsujs/core`: the error path is synchronous until something on it
  waits, as the success path is. Every failure the `onError` hooks see
  takes it — a thrown `HttpError`, a validation failure, a refusal — and
  each now costs 110–170 ns less, a refusal through the pipeline 776 ns
  where it was 880.

### Moving from 0.4

An `onError` hook on the application now receives `404`, `405` and a rate
limit's `429` as an `HttpError`. A hook that maps only errors it knows —
returning nothing for the rest — needs no change: the default envelope
answers as before. A hook that answers or logs every error should check
`error.status` if those three are not meant for it.

## 0.4.2 — 2026-09-26

The generated document describes each error once: every envelope is one
definition per status and code, whoever declared it, and a status of
envelopes can be discriminated by its code.

### Added

- `@tetsujs/openapi`: `fields` and `headers` on a response passed to
  `documented()` — what a hook adds to the error envelope, and the headers
  it sets. The envelope stays one definition in `components`, with the
  fields in it. Both take the new `JsonSchema` type, JSON Schema 2020-12
  keyword by keyword: a misspelled keyword or an unknown `type` does not
  compile.
- `@tetsujs/openapi`: a status whose alternatives are all error envelopes
  has a `discriminator` on `error`, mapping each code to its definition,
  so a generated client narrows on the code.
- `@tetsujs/openapi`: `docs({ ui: false })` serves the document without
  a page — for an origin that carries a session, where the page would run
  a CDN's code as the signed-in user. `assets` takes `integrity` hashes
  for a renderer of your own.
- `@tetsujs/rate-limit`: `key` reads what earlier `beforeParse` hooks
  returned, typed with `Requires` — a client address worked out once, for
  the limiter and whatever else needs it. The limiter then demands the
  field where it is mounted, like any hook with `Requires`.
- `@tetsujs/lifecycle`: `onShutdownSignals()` and `shutdown()` take a list
  of servers — one process serving several surfaces. They drain within one
  grace period, only a server still draining is cut, and the closers run
  once, after the last server.
- `@tetsujs/core/testing`: `serve(app, { hostname })`. Bun listens on both
  IPv4 and IPv6 by default and reports an IPv4 client as
  `::ffff:127.0.0.1`; `hostname: "127.0.0.1"` makes a test an IPv4 client,
  for checks that compare against `127.0.0.1`.

### Changed

- `@tetsujs/openapi`: the default renderers are pinned to an exact version
  and carry a Subresource Integrity hash — Scalar 1.72.1, Swagger UI
  5.33.0, Redoc 2.5.4. Scalar used to load whatever version was latest.
- `@tetsujs/openapi`: every error envelope is one definition in
  `components` per status and code, named after the code — a route's own
  included, which used to be inlined next to a named twin from a hook or
  the framework. The route's definition is the one kept; a definition
  with different fields is reported as a warning. A client regenerated
  from the document gets named types where it had anonymous ones.

### Fixed

- `@tetsujs/openapi`: the page of `docs()` mounted in a group fetched the
  document from the path as configured, without the group's prefix, and
  showed nothing.
- `@tetsujs/openapi`: a status and code declared by both the route and a
  hook was listed twice under the status, and a union the route declared
  was nested inside the status's `anyOf` instead of joining it.
- `@tetsujs/openapi`: a status the route declared and a hook or the
  framework described was documented as `"Response 403; <their
  description>"`. The placeholder is left out when something else
  describes the status, and a status only the route declares is named by
  its reason phrase — `"Not Found"`, not `"Response 404"`.
- `@tetsujs/rate-limit`: the documented `429` now has the `retryAfter`
  field and the `retry-after` header the refusal carries; the document
  described the bare envelope.

## 0.4.1 — 2026-09-25

### Added

- `@tetsujs/openapi`: `secured(hook, { anyOf: [a, b] })` for a hook that
  accepts any one of several credentials — a session cookie or a bearer
  token. The document lists every combination a client may bring, each
  alternative together with the schemes of the route's other hooks.
- `mutualTLS` among the security scheme types, as OpenAPI 3.1 has it.

### Fixed

- `@tetsujs/openapi`: a route guarded by several `secured()` hooks was
  documented as needing any one of their schemes — one `security` entry
  per hook, which OpenAPI reads as alternatives. Every hook runs, so every
  scheme is required: they are one entry now. Two hooks of one scheme with
  different scopes kept only the first one's scopes; they require both.

## 0.4.0 — 2026-09-24

Controllers are declared with `controller()`: a name, and a function from
the controller's dependencies to its routes. Everything a route declares —
hooks, schemas, a body limit — can now come from those dependencies, which
a class could not give its fields.

### Breaking changes

- `accessLog()` moved from `@tetsujs/request-id` to the new
  `@tetsujs/request-log`, with `AccessRecord`, `AccessLogOptions` and
  `AccessLogHook`. `@tetsujs/request-id` is `requestId()` alone.
- `ctx.route.controller`, and `controller` on `app.entries`, are optional:
  an object literal and a route mounted on its own have no name, where
  they were `"Object"` and `"(standalone)"`.
- Two controllers of one application with the same name are refused at
  startup — one class mounted twice, or one factory called twice,
  included. Two versions of an API are two names over one body.
- `@tetsujs/openapi`: two routes arriving at one `operationId` stop the
  application, naming both. Before, the second one was renamed after its
  method and path, or numbered — a method of a generated SDK changing
  without anyone seeing it. A route of an unnamed object is named by its
  field now, not `object<Field>`.

### Added

- `@tetsujs/request-log`, the request logs: `accessLog()`, and
  `arrivalLog()` — a `beforeParse` hook that writes a line when a request
  arrives, for the request that hangs or dies before `accessLog()` would
  see it. Its record is `{ method, path, requestId? }`, under the same
  rules as the access record: the pathname, no query, headers or body.
- `controller(name, build)`, the form of a controller the README shows.
  The name is what every `operationId` is built from, apart from the
  variable that holds the factory, so renaming code changes no client.
- `docs.operationId` on a route, for an id stated rather than derived.

### Fixed

- A `hooks` object the compiler would refuse is refused at startup too,
  for code the compiler did not check — `as never`, plain JavaScript,
  loose types. A slot element that is not a hook used to answer every
  request with a `500`; a hook under another slot ran at the wrong moment;
  a misspelled slot, `beforParse`, was never read, and the hook in it never
  ran. Each now stops `createApp`, naming the level, the slot and the
  position.

### Moving from 0.3

```ts
// 0.3
class OrdersController {
  constructor(private orders: OrderService) {}

  list = route({ method: "GET", path: "/orders", handler: () => this.orders.all() });
}

createApp({ routes: new OrdersController(orders) });

// 0.4
const ordersController = controller("Orders", ({ orders }: { orders: OrderService }) => ({
  list: route({ method: "GET", path: "/orders", handler: () => orders.all() }),
}));

createApp({ routes: ordersController({ orders }) });
```

A class keeps working and is named after itself, `operationId`s included;
`controller("Orders", …)` gives the same `ordersList` as `OrdersController`.

`accessLog` is imported from its new package:

```ts
// 0.3
import { accessLog, requestId } from "@tetsujs/request-id";

// 0.4
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";
```

## 0.3.0 — 2026-09-24

Hooks are mounted one way everywhere: an object keyed by slot, each slot a
list of hooks, so everything that runs for a request is written out where
it is mounted. This changes how hook packages are mounted.

- **Breaking.** `hooks` on `createApp` and `group` is one object keyed by
  slot, as on a route. The list of hook sets is gone; a list is refused at
  compile time and at startup with the form to write instead.
- **Breaking.** Every hook package returns one hook: `cors()` and
  `requestId()` and `rateLimit()` for `beforeParse`, `secureHeaders()` for
  `beforeResponse`, `accessLog()` for `afterResponse`. Their types are
  singular now: `CorsHook`, `RequestIdHook`, `AccessLogHook`,
  `RateLimitHook`, `SecureHeadersHook`.
- **Breaking.** `stack()` is removed. Write the hooks in the slot, or
  declare a shared array `as const`.
- `ctx.startedAt`: the monotonic time the core took the request, before any
  hook ran. `AccessRecord.durationMs` is measured from it and always present.
- One hook instance mounted twice in a route's chain — on a group and on a
  route under it, or twice in one slot — is refused at startup.
- A `hooks` object typed with an index signature — `Record<string, …>`, or
  what `Object.fromEntries` returns — is refused. Before, none of its slots
  was checked, on routes too.
- `@tetsujs/request-id`: the pino recipe in the README returned the stored
  object from `mixin`, which pino mutates, so one log line's fields leaked
  into every later line of the request. It returns a copy now:
  `mixin: () => ({ ...current() })`.

### Moving from 0.2

```ts
// 0.2
createApp({
  hooks: [cors(origins), requestId(), accessLog(), secureHeaders(), { beforeParse: [mine] }],
  routes,
});

// 0.3: each hook made once, and mounted in its slot
const browser = cors(origins);
const id = requestId();
const log = accessLog();
const secure = secureHeaders();

createApp({
  hooks: {
    beforeParse: [browser, id, mine],
    beforeResponse: [secure],
    afterResponse: [log],
  },
  routes,
});
```

On a route, `hooks: { beforeParse: [...limit.beforeParse] }` becomes
`hooks: { beforeParse: [limit] }`. Mount `cors()` first in `beforeParse`:
a hook before it that refuses answers without the CORS headers.

## 0.2.0 — 2026-09-24

- `createApp({ reportError })` receives the failures no response can
  carry: an error no `onError` hook answered, a broken response contract,
  a failing `afterResponse` hook, a WebSocket handler, a stream. A report
  has a `source`, the `error` itself and the request's `ctx`, typed from
  the application's hooks. Without it they are printed as before.
- `reportFailure(ctx, source, error)` lets a package report the same way.
  `@tetsujs/sse` reports stream failures through it, printed as
  `[tetsu] stream failed:` without a receiver.
- A handler that breaks its response contract throws
  `ResponseContractError`, reported once, with the schema's `issues` in a
  field of their own; it used to print two lines.
- `@tetsujs/lifecycle`: `onShutdownSignals` takes `reportError` for the
  closers that threw.
- A hook of a group or of the application sees what the hooks before it
  at the same level contributed. `[requestId(), { beforeParse: [scope] }]`
  compiles, so the `AsyncLocalStorage` recipe in `@tetsujs/request-id`
  works on the application, where it covers every request. Before, such a
  hook could require only the slot's base context.

## 0.1.0 — 2026-09-24

First release.

- `@tetsujs/core` — controllers and routes, lifecycle hooks, validation
  through Standard Schema, typed responses and errors, signed cookies,
  WebSocket endpoints, and testing helpers in `@tetsujs/core/testing`.
- `@tetsujs/cors`, `@tetsujs/rate-limit`, `@tetsujs/request-id`,
  `@tetsujs/secure-headers` — hook packages for the application.
- `@tetsujs/openapi` — an OpenAPI 3.1 document and docs page from the
  routes.
- `@tetsujs/typebox` — TypeBox schemas as DTOs.
- `@tetsujs/sse` — server-sent events and streamed responses.
- `@tetsujs/lifecycle` — graceful shutdown.

Requires Bun 1.4 or later and TypeScript 5.7 or later.
